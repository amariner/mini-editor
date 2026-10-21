import React, { lazy, Suspense } from 'react';

// xterm is only parsed and initialized when a terminal is actually requested.
const Terminal = lazy(() =>
  import('./terminal').then((module) => ({ default: module.TerminalView })),
);

export function TerminalView(props: React.ComponentProps<typeof Terminal>) {
  return (
    <Suspense
      fallback={
        <div role="status" className="muted">
          Abriendo terminal…
        </div>
      }
    >
      <Terminal {...props} />
    </Suspense>
  );
}
