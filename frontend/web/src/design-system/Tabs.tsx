import './components.css';

// Matches temp_images/tabs_ui.PNG: uppercase labels in a row, a full-width hairline under all of
// them, and a thicker accent-colored underline under whichever tab is active. The mockup's own
// underline is a warm coral, not this app's one established accent blue - kept as accent blue here
// instead of introducing a second interactive color, matching tokens.css's own "one accent...
// never substituted" discipline that every other page in this app already follows.
export interface TabItem {
  id: string;
  label: string;
}

export interface TabsProps {
  tabs: TabItem[];
  activeTab: string;
  onChange: (id: string) => void;
}

export function Tabs({ tabs, activeTab, onChange }: TabsProps) {
  return (
    <div className="ds-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === activeTab}
          className={['ds-tabs__tab', tab.id === activeTab ? 'ds-tabs__tab--active' : '']
            .filter(Boolean)
            .join(' ')}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
