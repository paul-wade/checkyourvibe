import ast
import json
import os
import re
import sys

SNIPPET_MAX_LENGTH = 200


def collapse_and_truncate(text: str) -> str:
    """Whitespace-collapse a source snippet and trim it to the protocol limit."""
    collapsed = re.sub(r"\s+", " ", text).strip()
    if len(collapsed) <= SNIPPET_MAX_LENGTH:
        return collapsed
    return f"{collapsed[: SNIPPET_MAX_LENGTH - 1]}…"


def snippet_for(source: str, node: ast.AST) -> str:
    """Extract the offending source text for a node, falling back to its line."""
    segment = ast.get_source_segment(source, node)
    if segment is None:
        line_index = getattr(node, "lineno", 1) - 1
        lines = source.splitlines()
        segment = lines[line_index] if 0 <= line_index < len(lines) else ""
    return collapse_and_truncate(segment)


def make_violation(
    file: str,
    source: str,
    node: ast.AST,
    rule_id: str,
    message: str,
    severity: str,
) -> dict:
    return {
        "file": file,
        "line": node.lineno,
        "column": node.col_offset + 1,
        "ruleId": rule_id,
        "message": message,
        "snippet": snippet_for(source, node),
        "severity": severity,
    }


def is_test_file(file: str) -> bool:
    """
    Whether this file is a test, by the convention Python's own tooling uses.

    `assert` is the idiomatic assertion in Python tests — the standard runners
    are built on it — so `no-assert-for-validation` must not fire there. Its
    premise, that `assert` is stripped under `-O`, is true and irrelevant: a test
    suite is not run under `-O`, and if it were, stripping the asserts would
    leave a suite that asserts nothing rather than a program that misbehaves.

    Measured, not assumed. Run against 316 files from three real codebases, the
    rule produced 353 findings and 335 of them were inside test files — a 95%
    false-positive rate, and the same shape as the TypeScript rule that fired
    fourteen times and was wrong fourteen times (see T7004). Excluding tests
    leaves 18, which is a believable number of real ones.

    Matched on the filename convention rather than on imports: the runners
    discover tests this way, so a file that does not match is not collected as a
    test, and a file that does is. The cost is a non-test file named `test_*`,
    which is rare and errs toward silence.
    """
    name = os.path.basename(file)
    return (
        name.startswith("test_")
        or name.endswith("_test.py")
        or name == "conftest.py"
    )


class AnalyzerVisitor(ast.NodeVisitor):
    def __init__(self, file: str, source: str, rules: dict):
        self.file = file
        self.source = source
        self.rules = rules
        self.violations: list[dict] = []

    def _add(self, node: ast.AST, rule_id: str, message: str) -> None:
        settings = self.rules.get(rule_id, {})
        severity = settings.get("severity", "error")
        self.violations.append(make_violation(self.file, self.source, node, rule_id, message, severity))

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        if "no-bare-except" in self.rules and node.type is None:
            self._add(
                node,
                "no-bare-except",
                "bare `except:` clause catches every exception, including control-flow exceptions",
            )
        self.generic_visit(node)

    def visit_Assert(self, node: ast.Assert) -> None:
        if "no-assert-for-validation" in self.rules and not is_test_file(self.file):
            self._add(
                node,
                "no-assert-for-validation",
                "`assert` is removed when Python runs with `-O`",
            )
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if "no-star-import" in self.rules:
            for alias in node.names:
                if alias.name == "*":
                    module = node.module or "<unknown>"
                    self._add(
                        node,
                        "no-star-import",
                        f"wildcard import from module `{module}`",
                    )
                    break
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self._check_mutable_defaults(node)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._check_mutable_defaults(node)
        self.generic_visit(node)

    def _check_mutable_defaults(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        if "no-mutable-default-arg" not in self.rules:
            return

        args = node.args
        if args.defaults:
            start = len(args.args) - len(args.defaults)
            for index, default in enumerate(args.defaults):
                parameter = args.args[start + index]
                if is_mutable_default(default):
                    self._add(
                        default,
                        "no-mutable-default-arg",
                        f"mutable default argument for parameter `{parameter.arg}`",
                    )

        for index, default in enumerate(args.kw_defaults):
            if default is not None:
                parameter = args.kwonlyargs[index]
                if is_mutable_default(default):
                    self._add(
                        default,
                        "no-mutable-default-arg",
                        f"mutable default argument for parameter `{parameter.arg}`",
                    )


def is_mutable_default(node: ast.expr) -> bool:
    """Return True for the syntactic forms that create a shared mutable default."""
    if isinstance(node, (ast.List, ast.Dict, ast.Set)):
        return True
    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Name) and node.func.id in ("set", "list", "dict"):
            if not node.args and not node.keywords:
                return True
    return False


def empty_response() -> dict:
    return {"protocol": 1, "violations": [], "skipped": [], "diagnostics": []}


def error_response(message: str) -> dict:
    response = empty_response()
    response["diagnostics"].append({"level": "error", "message": message})
    return response


def read_request() -> dict:
    """Read and validate the single AnalyzeRequest from stdin."""
    raw = sys.stdin.read()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Request is not valid JSON: {exc}") from exc

    if not isinstance(parsed, dict):
        raise ValueError("Request must be a JSON object")
    if parsed.get("protocol") != 1:
        raise ValueError("Request must use protocol version 1")
    if not isinstance(parsed.get("files"), list):
        raise ValueError("Request 'files' must be an array")
    if not isinstance(parsed.get("rules"), dict):
        raise ValueError("Request 'rules' must be an object")
    return parsed


def analyze_file(file: str, rules: dict) -> tuple[list[dict], list[dict]]:
    """Analyze one file, returning (violations, skipped_entries)."""
    try:
        with open(file, "r", encoding="utf-8", errors="replace") as handle:
            source = handle.read()
    except (OSError, UnicodeDecodeError) as exc:
        return [], [{"file": file, "reason": f"Could not read file: {exc}"}]

    try:
        tree = ast.parse(source, filename=file)
    except SyntaxError as exc:
        column = exc.offset if exc.offset is not None else 1
        return [], [
            {
                "file": file,
                "reason": f"SyntaxError: {exc.msg} at line {exc.lineno or 1}, column {column}",
            }
        ]

    visitor = AnalyzerVisitor(file, source, rules)
    visitor.visit(tree)
    return visitor.violations, []


def analyze(request: dict) -> dict:
    response = empty_response()
    rules = request.get("rules", {})
    for file in request.get("files", []):
        violations, skipped = analyze_file(file, rules)
        response["violations"].extend(violations)
        response["skipped"].extend(skipped)
    return response


def write_response(response: dict) -> None:
    # `ensure_ascii=False` keeps the JSON readable, but it also means non-ASCII
    # characters reach stdout as themselves. On Windows the default stdout
    # encoding is the system codepage, not UTF-8, so a single accented character
    # anywhere in a snippet raised UnicodeEncodeError and killed the process.
    #
    # The core saw a non-zero exit and reported every file in the batch as
    # skipped — correctly, and with the traceback attached — but a run over 316
    # real Python files then reported "0 files checked" with no violations. Every
    # one of them had been skipped for this. The 16-file sample that passed
    # earlier happened to be pure ASCII.
    #
    # Reconfiguring here rather than at import time so the process still works
    # when stdout has already been replaced by a caller that knows better.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.stdout.write(json.dumps(response, ensure_ascii=False))
    sys.stdout.flush()


def main() -> int:
    try:
        request = read_request()
    except ValueError as exc:
        write_response(error_response(str(exc)))
        return 1

    try:
        response = analyze(request)
    except Exception as exc:
        write_response(error_response(f"Analyzer crashed: {exc}"))
        return 1

    write_response(response)
    return 0


if __name__ == "__main__":
    sys.exit(main())
