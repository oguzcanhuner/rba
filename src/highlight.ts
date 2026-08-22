import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { createElement, type ReactNode } from 'react';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('java', java);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('markdown', markdown);

const languagesByExtension: Record<string, string> = {
  bash: 'bash',
  cjs: 'javascript',
  css: 'css',
  gemfile: 'ruby',
  go: 'go',
  html: 'xml',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  markdown: 'markdown',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  rake: 'ruby',
  rb: 'ruby',
  rs: 'rust',
  sass: 'scss',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  svelte: 'xml',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'xml',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
};

export function languageForPath(path: string) {
  const basename = path.split('/').pop() ?? path;
  const extension = basename.includes('.')
    ? (basename.split('.').pop()?.toLowerCase() ?? '')
    : basename.toLowerCase();
  return languagesByExtension[extension] ?? null;
}

export function highlightLine(code: string, language: string | null) {
  if (!language) {
    return escapeHtml(code);
  }
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

export function highlightedNodes(html: string): ReactNode[] {
  type HighlightNode = {
    children: Array<HighlightNode | string>;
    className: string | null;
  };
  const root: HighlightNode = { children: [], className: null };
  const stack = [root];
  const tags = /<span class="([^"]+)">|<\/span>/g;
  let position = 0;

  for (const match of html.matchAll(tags)) {
    const index = match.index ?? position;
    if (index > position) {
      stack.at(-1)?.children.push(decodeEntities(html.slice(position, index)));
    }
    if (match[1]) {
      const node: HighlightNode = { children: [], className: match[1] };
      stack.at(-1)?.children.push(node);
      stack.push(node);
    } else if (stack.length > 1) {
      stack.pop();
    }
    position = index + match[0].length;
  }
  if (position < html.length) {
    stack.at(-1)?.children.push(decodeEntities(html.slice(position)));
  }

  function renderNode(node: HighlightNode | string, key: number): ReactNode {
    return typeof node === 'string'
      ? node
      : createElement(
          'span',
          { className: node.className ?? undefined, key },
          node.children.map(renderNode),
        );
  }

  return root.children.map(renderNode);
}

function decodeEntities(value: string) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
