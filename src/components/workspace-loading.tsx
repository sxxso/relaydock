import "./workspace-loading.css";

export function WorkspaceLoading({ brand }: { brand: React.ReactNode }) {
  return (
    <div className="workspace-loading" role="status" aria-live="polite" aria-label="正在整理工作台">
      <header className="loading-header" aria-hidden="true">{brand}<span className="skeleton skeleton-nav" /></header>
      <div className="loading-workbench">
        <div className="loading-heading" aria-hidden="true"><span className="skeleton skeleton-title" /><span className="skeleton skeleton-summary" /></div>
        <div className="loading-toolbar" aria-hidden="true"><span className="skeleton skeleton-search" /><span className="skeleton skeleton-filter" /><span className="skeleton skeleton-filter" /></div>
        <div className="loading-map" aria-hidden="true">
          <div className="loading-land loading-land-a" /><div className="loading-land loading-land-b" />
          <div className="loading-composition">
            <span className="loading-square loading-square-main" /><span className="loading-square loading-square-accent" />
            <span className="loading-square loading-square-warm" /><span className="loading-rule" />
          </div>
        </div>
        <p className="loading-caption">正在整理工作台…</p>
      </div>
    </div>
  );
}
