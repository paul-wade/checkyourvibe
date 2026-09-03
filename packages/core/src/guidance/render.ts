import type { RuleManifest } from '../protocol/index.js';
import { guidanceSections, type GuidanceSection } from './templates.js';

const TERMINAL_WIDTH = 88;

function wrapLine(text: string, width: number): string[] {
  const wrapped: string[] = [];

  for (const line of text.split('\n')) {
    if (line.length === 0) {
      wrapped.push('');
      continue;
    }

    let start = 0;
    while (start < line.length) {
      const remaining = line.length - start;
      if (remaining <= width) {
        wrapped.push(line.slice(start));
        break;
      }

      const chunk = line.slice(start, start + width);
      let breakAt = chunk.lastIndexOf(' ');
      if (breakAt <= 0) {
        breakAt = width;
      }

      wrapped.push(line.slice(start, start + breakAt));
      start += breakAt;

      while (line.charAt(start) === ' ') {
        start += 1;
      }
    }
  }

  return wrapped;
}

function formatTerminalSection(
  section: GuidanceSection,
  out: string[],
): void {
  out.push('', section.heading);

  if (section.heading === 'Example') {
    const labels = ['Bad', 'Good'];
    let index = 0;
    for (const line of section.lines) {
      const label = labels[index] ?? 'Example';
      index += 1;
      out.push(`${label}:`);
      for (const wrapped of wrapLine(line, TERMINAL_WIDTH)) {
        out.push(wrapped);
      }
      if (index < section.lines.length) {
        out.push('');
      }
    }
    return;
  }

  for (const line of section.lines) {
    for (const wrapped of wrapLine(line, TERMINAL_WIDTH)) {
      out.push(wrapped);
    }
  }
}

/**
 * Render a rule to 88-column plain text with no ANSI escapes.
 */
export function renderTerminal(rule: RuleManifest): string {
  const out: string[] = [rule.id];
  for (const section of guidanceSections(rule)) {
    formatTerminalSection(section, out);
  }
  return out.join('\n');
}

function formatMarkdownSection(
  section: GuidanceSection,
  out: string[],
): void {
  out.push('', `## ${section.heading}`);

  if (section.heading === 'Example') {
    const labels = ['Bad', 'Good'];
    let index = 0;
    for (const code of section.lines) {
      const label = labels[index] ?? 'Example';
      index += 1;
      out.push(`${label}:`, '```', code, '```');
    }
    return;
  }

  for (const line of section.lines) {
    out.push(line);
  }
}

/**
 * Render a rule to markdown with section headings and fenced examples.
 */
export function renderMarkdown(rule: RuleManifest): string {
  const out: string[] = [`# ${rule.id}`];
  for (const section of guidanceSections(rule)) {
    formatMarkdownSection(section, out);
  }
  return out.join('\n');
}
