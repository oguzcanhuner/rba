import type { AuditArtifact } from '../claude';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './ui/collapsible';

type AuditArtifactListProps = {
  artifacts: AuditArtifact[];
};

export function AuditArtifactList({ artifacts }: AuditArtifactListProps) {
  return (
    <div className="audit-artifacts">
      {artifacts.map((artifact) => (
        <Collapsible className="audit-artifact audit-trace" key={artifact.id}>
          <CollapsibleTrigger className="audit-artifact__trigger audit-trace__trigger">
            <span className="audit-trace__identity">
              <code className="audit-artifact__path">{artifact.testPath}</code>
              <span>
                {artifact.testName ?? `${artifact.assertions.length} tests`}
              </span>
            </span>
            <span
              className={`audit-trace__status audit-trace__status--${artifact.success ? 'passed' : 'failed'}`}
            >
              {artifact.success ? 'Passed' : 'Failed'} · {artifact.durationMs}ms
            </span>
            <span className="audit-artifact__chevron" aria-hidden="true">
              ›
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="audit-trace__content">
            <div className="audit-trace__meta">
              {artifact.framework} · {artifact.assertions.length}{' '}
              {artifact.assertions.length === 1 ? 'test' : 'tests'} · traced{' '}
              {new Date(artifact.createdAt).toLocaleString()}
            </div>
            <ol className="audit-trace__assertions">
              {artifact.assertions.map((assertion) => (
                <li key={assertion.name}>
                  <div className="audit-trace__assertion">
                    <span
                      className={`audit-trace__dot audit-trace__dot--${assertion.status}`}
                      aria-hidden="true"
                    />
                    <span
                      className="audit-trace__assertion-name"
                      title={assertion.name}
                    >
                      {assertion.name}
                    </span>
                  </div>
                  {assertion.failures.map((failure) => (
                    <pre className="audit-trace__failure" key={failure}>
                      {failure}
                    </pre>
                  ))}
                </li>
              ))}
            </ol>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}
