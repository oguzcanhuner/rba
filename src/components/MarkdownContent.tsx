import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

type MarkdownContentProps = {
  children: string;
  className?: string;
};

export const MarkdownContent = memo(function MarkdownContent({
  children,
  className,
}: MarkdownContentProps) {
  return (
    <div className={cn('typeset typeset-chat', className)}>
      <ReactMarkdown
        disallowedElements={['a', 'img']}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        remarkPlugins={[remarkGfm]}
        skipHtml
        unwrapDisallowed
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
