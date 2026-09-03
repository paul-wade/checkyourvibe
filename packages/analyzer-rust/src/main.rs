use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Write};
use std::panic;
use std::process;

use proc_macro2::Span;
use serde::Serialize;
use serde_json::Value;
use syn::spanned::Spanned;
use syn::visit::Visit;
use syn::{
    Attribute, Expr, ExprMethodCall, ExprUnsafe, File, ImplItemFn, ItemFn, ItemMod, Local, Macro,
    Meta, Pat, TraitItemFn,
};

const SNIPPET_MAX_LENGTH: usize = 200;

// -----------------------------------------------------------------------------
// Protocol types
// -----------------------------------------------------------------------------

struct ParsedRequest {
    _repo_root: String,
    _mode: String,
    files: Vec<String>,
    rules: HashMap<String, String>,
}

#[derive(Serialize)]
struct AnalyzeResponse {
    protocol: i64,
    violations: Vec<Violation>,
    skipped: Vec<SkippedFile>,
    diagnostics: Vec<Diagnostic>,
}

#[derive(Serialize)]
struct Violation {
    file: String,
    line: u32,
    column: u32,
    #[serde(rename = "endLine", skip_serializing_if = "Option::is_none")]
    end_line: Option<u32>,
    #[serde(rename = "endColumn", skip_serializing_if = "Option::is_none")]
    end_column: Option<u32>,
    #[serde(rename = "ruleId")]
    rule_id: String,
    message: String,
    snippet: String,
    severity: String,
}

#[derive(Serialize)]
struct SkippedFile {
    file: String,
    reason: String,
}

#[derive(Serialize)]
struct Diagnostic {
    level: String,
    message: String,
}

// -----------------------------------------------------------------------------
// Request parsing: permissive, with field-by-field diagnostics.
// -----------------------------------------------------------------------------

fn parse_request(text: &str) -> Result<ParsedRequest, String> {
    let value: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => return Err(format!("Request body is not valid JSON: {e}")),
    };

    let obj = match value.as_object() {
        Some(o) => o,
        None => return Err("Request body must be a JSON object".to_string()),
    };

    if obj.get("protocol").and_then(Value::as_i64) != Some(1) {
        return Err("Request field \"protocol\" must be present and equal to 1".to_string());
    }

    let repo_root = match obj.get("repoRoot").and_then(Value::as_str) {
        Some(s) => s.to_string(),
        None => return Err("Request field \"repoRoot\" must be a string".to_string()),
    };

    let mode = match obj.get("mode").and_then(Value::as_str) {
        Some(s) if s == "file" || s == "project" => s.to_string(),
        _ => return Err("Request field \"mode\" must be \"file\" or \"project\"".to_string()),
    };

    let files = match obj.get("files").and_then(Value::as_array) {
        Some(arr) => {
            let mut out = Vec::with_capacity(arr.len());
            for (i, item) in arr.iter().enumerate() {
                match item.as_str() {
                    Some(s) => out.push(s.to_string()),
                    None => return Err(format!("Request field \"files[{i}]\" must be a string")),
                }
            }
            out
        }
        None => return Err("Request field \"files\" must be an array of strings".to_string()),
    };

    let rules = match obj.get("rules").and_then(Value::as_object) {
        Some(map) => {
            let mut out = HashMap::with_capacity(map.len());
            for (id, config) in map {
                let config_obj = match config.as_object() {
                    Some(o) => o,
                    None => return Err(format!("Request field \"rules.{id}\" must be an object")),
                };
                let severity = match config_obj.get("severity").and_then(Value::as_str) {
                    Some(s) if s == "error" || s == "warning" => s.to_string(),
                    _ => {
                        return Err(format!(
                            "Request field \"rules.{id}.severity\" must be \"error\" or \"warning\""
                        ))
                    }
                };
                out.insert(id.clone(), severity);
            }
            out
        }
        None => return Err("Request field \"rules\" must be an object keyed by rule id".to_string()),
    };

    Ok(ParsedRequest {
        _repo_root: repo_root,
        _mode: mode,
        files,
        rules,
    })
}

fn empty_response() -> AnalyzeResponse {
    AnalyzeResponse {
        protocol: 1,
        violations: Vec::new(),
        skipped: Vec::new(),
        diagnostics: Vec::new(),
    }
}

fn error_response(message: &str) -> AnalyzeResponse {
    let mut response = empty_response();
    response.diagnostics.push(Diagnostic {
        level: "error".to_string(),
        message: message.to_string(),
    });
    response
}

// -----------------------------------------------------------------------------
// Source map and snippet extraction
// -----------------------------------------------------------------------------

struct SourceMap {
    lines: Vec<String>,
}

impl SourceMap {
    fn new(source: &str) -> Self {
        // `lines()` drops the trailing newline, which matches proc_macro2 line counting.
        SourceMap {
            lines: source.lines().map(|s| s.to_string()).collect(),
        }
    }

    fn text_for_span(&self, span: &Span) -> String {
        let start = span.start();
        let end = span.end();

        if start.line == 0 || end.line == 0 {
            return String::new();
        }

        let mut result = String::new();
        for line_num in start.line..=end.line {
            let Some(line) = self.lines.get(line_num.saturating_sub(1)) else {
                continue;
            };
            let start_col = if line_num == start.line { start.column } else { 0 };
            let end_col = if line_num == end.line {
                end.column
            } else {
                line.chars().count()
            };
            if end_col > start_col {
                let part: String = line.chars().skip(start_col).take(end_col - start_col).collect();
                if line_num > start.line {
                    result.push('\n');
                }
                result.push_str(&part);
            }
        }
        result
    }

    fn has_safety_comment(&self, span: &Span) -> bool {
        let start = span.start();
        let end = span.end();
        if start.line == 0 {
            return false;
        }

        // Search the line before the unsafe keyword and every line inside the block.
        let first_line = start.line.saturating_sub(1).max(1);
        for line_num in first_line..=end.line {
            if let Some(line) = self.lines.get(line_num.saturating_sub(1)) {
                if line_has_safety_comment(line) {
                    return true;
                }
            }
        }
        false
    }
}

fn line_has_safety_comment(line: &str) -> bool {
    // Accept `// SAFETY:` or `//SAFETY:`. Also accept `/* SAFETY:` for block comments.
    for pattern in ["// SAFETY:", "//SAFETY:", "/* SAFETY:", "/*SAFETY:"] {
        if line.contains(pattern) {
            return true;
        }
    }
    false
}

fn collapse_and_truncate(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    let joined = words.join(" ");
    let chars: Vec<char> = joined.chars().collect();
    if chars.len() <= SNIPPET_MAX_LENGTH {
        joined
    } else {
        chars.into_iter().take(SNIPPET_MAX_LENGTH - 1).collect::<String>() + "…"
    }
}

fn snippet_for(source_map: &SourceMap, span: &Span) -> String {
    collapse_and_truncate(&source_map.text_for_span(span))
}

// -----------------------------------------------------------------------------
// Test context detection
// -----------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Tristate {
    True,
    False,
    Unknown,
}

fn is_test_context(attrs: &[Attribute]) -> bool {
    for attr in attrs {
        if attr.path().is_ident("test") {
            return true;
        }
        if attr
            .path()
            .segments
            .last()
            .map_or(false, |s| s.ident == "test")
        {
            return true;
        }
        if attr.path().is_ident("cfg") {
            if let Ok(inner) = attr.parse_args::<Meta>() {
                if cfg_is_test_only(&inner) {
                    return true;
                }
            }
        }
    }
    false
}

fn cfg_is_test_only(meta: &Meta) -> bool {
    let when_test_false = eval_cfg(meta, false);
    let when_test_true = eval_cfg(meta, true);
    // The item is test-only if it can never be active when test=false, and it is
    // not dead code (it is at least possibly active when test=true).
    when_test_false == Tristate::False && when_test_true != Tristate::False
}

fn eval_cfg(meta: &Meta, test_active: bool) -> Tristate {
    match meta {
        Meta::Path(path) if path.is_ident("test") => {
            if test_active {
                Tristate::True
            } else {
                Tristate::False
            }
        }
        Meta::Path(_) | Meta::NameValue(_) => Tristate::Unknown,
        Meta::List(list) => {
            if list.path.is_ident("not") {
                match list.parse_args::<Meta>() {
                    Ok(inner) => negate(eval_cfg(&inner, test_active)),
                    Err(_) => Tristate::Unknown,
                }
            } else if list.path.is_ident("all") {
                let mut any_false = false;
                let mut any_unknown = false;
                match list.parse_args_with(syn::punctuated::Punctuated::<
                    Meta,
                    syn::token::Comma,
                >::parse_terminated) {
                    Ok(items) => {
                        for item in items {
                            match eval_cfg(&item, test_active) {
                                Tristate::False => any_false = true,
                                Tristate::Unknown => any_unknown = true,
                                Tristate::True => {}
                            }
                        }
                    }
                    Err(_) => any_unknown = true,
                }
                if any_false {
                    Tristate::False
                } else if any_unknown {
                    Tristate::Unknown
                } else {
                    Tristate::True
                }
            } else if list.path.is_ident("any") {
                let mut any_true = false;
                let mut any_unknown = false;
                match list.parse_args_with(syn::punctuated::Punctuated::<
                    Meta,
                    syn::token::Comma,
                >::parse_terminated) {
                    Ok(items) => {
                        for item in items {
                            match eval_cfg(&item, test_active) {
                                Tristate::True => any_true = true,
                                Tristate::Unknown => any_unknown = true,
                                Tristate::False => {}
                            }
                        }
                    }
                    Err(_) => any_unknown = true,
                }
                if any_true {
                    Tristate::True
                } else if any_unknown {
                    Tristate::Unknown
                } else {
                    Tristate::False
                }
            } else {
                Tristate::Unknown
            }
        }
    }
}

fn negate(t: Tristate) -> Tristate {
    match t {
        Tristate::True => Tristate::False,
        Tristate::False => Tristate::True,
        Tristate::Unknown => Tristate::Unknown,
    }
}

// -----------------------------------------------------------------------------
// Analyzer visitor
// -----------------------------------------------------------------------------

struct Analyzer {
    file: String,
    rules: HashSet<String>,
    rule_severity: HashMap<String, String>,
    source_map: SourceMap,
    in_test: usize,
    violations: Vec<Violation>,
}

impl Analyzer {
    fn add_violation(&mut self, span: &Span, rule_id: &str, message: &str) {
        let start = span.start();
        let end = span.end();
        let severity = self
            .rule_severity
            .get(rule_id)
            .cloned()
            .unwrap_or_else(|| "error".to_string());

        self.violations.push(Violation {
            file: self.file.clone(),
            line: start.line as u32,
            column: (start.column + 1) as u32,
            end_line: if end.line > 0 { Some(end.line as u32) } else { None },
            end_column: if end.line > 0 { Some((end.column + 1) as u32) } else { None },
            rule_id: rule_id.to_string(),
            message: message.to_string(),
            snippet: snippet_for(&self.source_map, span),
            severity,
        });
    }
}

impl<'ast> Visit<'ast> for Analyzer {
    fn visit_item_mod(&mut self, node: &'ast ItemMod) {
        let enter = is_test_context(&node.attrs);
        if enter {
            self.in_test += 1;
        }
        syn::visit::visit_item_mod(self, node);
        if enter {
            self.in_test -= 1;
        }
    }

    fn visit_item_fn(&mut self, node: &'ast ItemFn) {
        let enter = is_test_context(&node.attrs);
        if enter {
            self.in_test += 1;
        }
        syn::visit::visit_item_fn(self, node);
        if enter {
            self.in_test -= 1;
        }
    }

    fn visit_impl_item_fn(&mut self, node: &'ast ImplItemFn) {
        let enter = is_test_context(&node.attrs);
        if enter {
            self.in_test += 1;
        }
        syn::visit::visit_impl_item_fn(self, node);
        if enter {
            self.in_test -= 1;
        }
    }

    fn visit_trait_item_fn(&mut self, node: &'ast TraitItemFn) {
        let enter = is_test_context(&node.attrs);
        if enter {
            self.in_test += 1;
        }
        syn::visit::visit_trait_item_fn(self, node);
        if enter {
            self.in_test -= 1;
        }
    }

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        if self.rules.contains("no-unwrap") && self.in_test == 0 {
            let method = node.method.to_string();
            if method == "unwrap" || method == "expect" {
                self.add_violation(&node.span(), "no-unwrap", &format!("`.{method}()` on an `Option` or `Result`"));
            }
        }
        syn::visit::visit_expr_method_call(self, node);
    }

    fn visit_macro(&mut self, node: &'ast Macro) {
        if self.rules.contains("no-panic-in-library") && self.in_test == 0 {
            if let Some(last) = node.path.segments.last() {
                let name = last.ident.to_string();
                if name == "panic" || name == "todo" || name == "unimplemented" {
                    self.add_violation(&node.span(), "no-panic-in-library", &format!("`{name}!` macro invocation"));
                }
            }
        }
        syn::visit::visit_macro(self, node);
    }

    fn visit_expr_unsafe(&mut self, node: &'ast ExprUnsafe) {
        if self.rules.contains("no-unsafe-block") {
            if !self.source_map.has_safety_comment(&node.span()) {
                self.add_violation(&node.span(), "no-unsafe-block", "`unsafe` block with no `// SAFETY:` justification");
            }
        }
        syn::visit::visit_expr_unsafe(self, node);
    }

    fn visit_local(&mut self, node: &'ast Local) {
        if self.rules.contains("no-ignored-result") {
            if matches!(node.pat, Pat::Wild(_)) {
                if let Some(init) = &node.init {
                    match init.expr.as_ref() {
                        Expr::Call(_) | Expr::MethodCall(_) => {
                            self.add_violation(&node.span(), "no-ignored-result", "`let _ = ...` discarding a call result");
                        }
                        _ => {}
                    }
                }
            }
        }
        syn::visit::visit_local(self, node);
    }
}

// -----------------------------------------------------------------------------
// File analysis
// -----------------------------------------------------------------------------

fn analyze_file(file: &str, rules: &HashSet<String>, rule_severity: &HashMap<String, String>) -> (Vec<Violation>, Option<String>) {
    let source = match std::fs::read_to_string(file) {
        Ok(s) => s,
        Err(e) => return (Vec::new(), Some(format!("Could not read file: {e}"))),
    };

    let ast: File = match syn::parse_file(&source) {
        Ok(f) => f,
        Err(e) => return (Vec::new(), Some(format!("Parse error: {e}"))),
    };

    let mut analyzer = Analyzer {
        file: file.to_string(),
        rules: rules.clone(),
        rule_severity: rule_severity.clone(),
        source_map: SourceMap::new(&source),
        in_test: 0,
        violations: Vec::new(),
    };
    analyzer.visit_file(&ast);
    (analyzer.violations, None)
}

fn analyze(request: &ParsedRequest) -> AnalyzeResponse {
    let mut response = empty_response();

    let enabled_rules: HashSet<String> = request.rules.keys().cloned().collect();
    let rule_severity = request.rules.clone();

    for file in &request.files {
        let (violations, skip_reason) = analyze_file(file, &enabled_rules, &rule_severity);
        response.violations.extend(violations);
        if let Some(reason) = skip_reason {
            response.skipped.push(SkippedFile {
                file: file.clone(),
                reason,
            });
        }
    }

    response
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

fn write_response(response: &AnalyzeResponse) {
    let mut stdout = io::stdout();
    if let Ok(json) = serde_json::to_string(response) {
        let _ = stdout.write_all(json.as_bytes());
    }
    let _ = stdout.flush();
}

fn main() {
    let mut input = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input) {
        write_response(&error_response(&format!("Could not read stdin: {e}")));
        process::exit(1);
    }

    let request = match parse_request(&input) {
        Ok(r) => r,
        Err(e) => {
            write_response(&error_response(&e));
            process::exit(1);
        }
    };

    let result = panic::catch_unwind(panic::AssertUnwindSafe(|| analyze(&request)));
    match result {
        Ok(response) => {
            write_response(&response);
            process::exit(0);
        }
        Err(_) => {
            let mut response = empty_response();
            response.diagnostics.push(Diagnostic {
                level: "error".to_string(),
                message: "Analyzer crashed while processing the request".to_string(),
            });
            for file in &request.files {
                response.skipped.push(SkippedFile {
                    file: file.clone(),
                    reason: "Analyzer crashed before this file could be processed".to_string(),
                });
            }
            write_response(&response);
            process::exit(1);
        }
    }
}
