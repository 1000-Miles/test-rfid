/* @ds-bundle: {"format":4,"namespace":"Ds1000MilesHubDesignSystem_d28262","components":[],"sourceHashes":{"ui_kits/hub/dashboard-page.jsx":"7cdf2ddaf490","ui_kits/hub/hub-app.jsx":"df47225a4817","ui_kits/hub/hub-header.jsx":"160920e24ce3","ui_kits/hub/hub-icon.jsx":"a486d9574cdd","ui_kits/hub/hub-sidebar.jsx":"eb780b934211","ui_kits/hub/listing-wizard.jsx":"4166d962c07d","ui_kits/hub/listings-page.jsx":"94f3441f6138"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.Ds1000MilesHubDesignSystem_d28262 = window.Ds1000MilesHubDesignSystem_d28262 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// ui_kits/hub/dashboard-page.jsx
try { (() => {
// DashboardPage.jsx — alternative landing page: hero + workflows + KPIs.

function DashboardPage({
  onNewListing
}) {
  const workflows = [{
    id: 1,
    title: 'Q2 Listing Refresh — 40 ASINs',
    sub: 'Update titles, bullets, backend keywords · BSCOOL',
    progress: 72,
    type: 'primary'
  }, {
    id: 2,
    title: 'Vendor Price Round — Plush Supplier 03',
    sub: '3 RFQs awaiting response · Target close Apr 28',
    progress: 35,
    type: 'warning'
  }, {
    id: 3,
    title: 'Copyright Clearance — New IP Deck',
    sub: '11 designs in legal review · Nexus',
    progress: 58,
    type: 'primary'
  }, {
    id: 4,
    title: 'PPC Budget Reset — May',
    sub: 'Refreshed daily caps across 24 campaigns',
    progress: 100,
    type: 'success'
  }];
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "hub-page-title"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", null, "Good morning, Maria"), /*#__PURE__*/React.createElement("p", null, "Monday \xB7 April 20 \xB7 4 workflows in progress across your teams")), /*#__PURE__*/React.createElement("div", {
    className: "hub-page-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn--outline"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "arrowUp",
    size: 14
  }), " Report"), /*#__PURE__*/React.createElement("button", {
    className: "btn",
    onClick: onNewListing
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "plus",
    size: 14
  }), " New Listing"))), /*#__PURE__*/React.createElement("div", {
    className: "hub-hero"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-hero__eyebrow"
  }, "AMAZON \xB7 WEEKLY DIGEST"), /*#__PURE__*/React.createElement("h2", {
    className: "hub-hero__title"
  }, "ACOS held at 26% \u2014 a 1.2pt improvement over last week."), /*#__PURE__*/React.createElement("p", {
    className: "hub-hero__sub"
  }, "Spend up $520 driven by 3 new campaign launches under Popcraze. Review recommended."), /*#__PURE__*/React.createElement("div", {
    className: "hub-hero__actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn--light"
  }, "Open Digest"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn--light",
    style: {
      background: 'transparent',
      border: '1px solid rgba(255,255,255,.3)'
    }
  }, "Dismiss"))), /*#__PURE__*/React.createElement("div", {
    className: "hub-grid-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-card__header"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "hub-card__title"
  }, "Active Workflows"), /*#__PURE__*/React.createElement("a", {
    href: "#",
    className: "hub-card__link"
  }, "View all \u203A")), workflows.map(w => /*#__PURE__*/React.createElement("div", {
    key: w.id,
    className: "workflow-item"
  }, /*#__PURE__*/React.createElement("div", {
    className: "workflow-item__main"
  }, /*#__PURE__*/React.createElement("p", {
    className: "workflow-item__title"
  }, w.title), /*#__PURE__*/React.createElement("div", {
    className: "workflow-item__sub"
  }, w.sub)), /*#__PURE__*/React.createElement("div", {
    className: "workflow-item__progress"
  }, /*#__PURE__*/React.createElement("div", {
    className: "progress-track"
  }, /*#__PURE__*/React.createElement("div", {
    className: `progress-fill ${w.type}`,
    style: {
      width: `${w.progress}%`
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      color: w.type === 'warning' ? 'var(--color-warning)' : w.type === 'success' ? 'var(--color-success)' : 'var(--fg2)'
    }
  }, w.progress, "%"))))), /*#__PURE__*/React.createElement("div", {
    className: "hub-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-card__header"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "hub-card__title"
  }, "Needs Attention")), /*#__PURE__*/React.createElement("div", {
    className: "hub-alert hub-alert--warning",
    style: {
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "hub-alert__title"
  }, "Low inventory \xB7 B0CM6QXXXX"), /*#__PURE__*/React.createElement("div", null, "Stock drops below 10 units in ~3 days."))), /*#__PURE__*/React.createElement("div", {
    className: "hub-alert hub-alert--error",
    style: {
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "hub-alert__title"
  }, "ACOS threshold exceeded"), /*#__PURE__*/React.createElement("div", null, "B0CM6Q is at 42% (target 30%). Pause recommended."))), /*#__PURE__*/React.createElement("div", {
    className: "hub-alert hub-alert--info"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "hub-alert__title"
  }, "3 new keywords to review"), /*#__PURE__*/React.createElement("div", null, "Popcraze \xB7 Kids Activity Pad campaign."))))));
}
window.DashboardPage = DashboardPage;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/hub/dashboard-page.jsx", error: String((e && e.message) || e) }); }

// ui_kits/hub/hub-app.jsx
try { (() => {
// App.jsx — top-level Hub app with click-thru routing.

function App() {
  const [activeKey, setActiveKey] = React.useState('dashboard');
  const [collapsed, setCollapsed] = React.useState(false);
  const [wizardOpen, setWizardOpen] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState('B09FL9KRY4');
  const [toast, setToast] = React.useState(null);

  // Add dashboard as virtual first item
  const crumbsFor = key => {
    const map = {
      dashboard: ['Home'],
      listings: ['Amazon', 'Listings'],
      ppc: ['Amazon', 'PPC Campaigns'],
      keywords: ['Amazon', 'Keyword Research'],
      analytics: ['Amazon', 'ACOS Analytics'],
      vendors: ['OEM', 'Vendors'],
      pricing: ['OEM', 'Pricing'],
      copyright: ['OEM', 'Copyright'],
      products: ['Nexus', 'Products'],
      tools: ['Nexus', 'Tooling']
    };
    return map[key] || ['Home'];
  };
  const handlePublish = () => {
    setWizardOpen(false);
    setToast({
      title: 'Listing published',
      sub: 'B09FL9KRY4 is now live on Amazon US.'
    });
    setTimeout(() => setToast(null), 3500);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "hub-app"
  }, /*#__PURE__*/React.createElement(Sidebar, {
    activeKey: activeKey,
    onNavigate: setActiveKey,
    collapsed: collapsed
  }), /*#__PURE__*/React.createElement("div", {
    className: "hub-main"
  }, /*#__PURE__*/React.createElement(Header, {
    onToggleSidebar: () => setCollapsed(!collapsed),
    crumbs: crumbsFor(activeKey)
  }), /*#__PURE__*/React.createElement("main", {
    className: "hub-content"
  }, activeKey === 'dashboard' && /*#__PURE__*/React.createElement(DashboardPage, {
    onNewListing: () => setWizardOpen(true)
  }), activeKey === 'listings' && /*#__PURE__*/React.createElement(ListingsPage, {
    onNew: () => setWizardOpen(true),
    selectedId: selectedId,
    onSelect: setSelectedId
  }), activeKey !== 'dashboard' && activeKey !== 'listings' && /*#__PURE__*/React.createElement(EmptyPlaceholder, {
    keyName: activeKey
  }))), wizardOpen && /*#__PURE__*/React.createElement(ListingWizard, {
    onClose: () => setWizardOpen(false),
    onPublish: handlePublish
  }), toast && /*#__PURE__*/React.createElement("div", {
    className: "hub-toast"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hub-toast__dot"
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "hub-toast__title"
  }, toast.title), /*#__PURE__*/React.createElement("div", {
    className: "hub-toast__sub"
  }, toast.sub))));
}
function EmptyPlaceholder({
  keyName
}) {
  const labels = {
    ppc: 'PPC Campaigns',
    keywords: 'Keyword Research',
    analytics: 'ACOS Analytics',
    vendors: 'Vendors',
    pricing: 'Pricing',
    copyright: 'Copyright',
    products: 'Products',
    tools: 'Tooling'
  };
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "hub-page-title"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", null, labels[keyName] || 'Page'), /*#__PURE__*/React.createElement("p", null, "This surface isn't reconstructed in the UI kit \u2014 it uses the same shell, table, and wizard patterns as Listings."))), /*#__PURE__*/React.createElement("div", {
    className: "hub-card",
    style: {
      minHeight: 320,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--fg2)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '.08em',
      textTransform: 'uppercase',
      marginBottom: 4
    }
  }, "Placeholder"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14
    }
  }, "Real Hub surfaces live behind SSO \u2014 not reconstructed."))));
}
window.App = App;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/hub/hub-app.jsx", error: String((e && e.message) || e) }); }

// ui_kits/hub/hub-header.jsx
try { (() => {
// Header.jsx — top app bar: toggle, breadcrumbs, search, actions.

function Header({
  onToggleSidebar,
  crumbs = []
}) {
  return /*#__PURE__*/React.createElement("header", {
    className: "hub-header"
  }, /*#__PURE__*/React.createElement("button", {
    className: "hub-header__toggle",
    onClick: onToggleSidebar,
    title: "Toggle sidebar"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "menu",
    size: 18
  })), /*#__PURE__*/React.createElement("nav", {
    className: "hub-breadcrumbs"
  }, crumbs.map((c, i) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: i
  }, i > 0 && /*#__PURE__*/React.createElement("span", {
    className: "hub-breadcrumbs__sep"
  }, "\u203A"), /*#__PURE__*/React.createElement("span", {
    className: `hub-breadcrumbs__item ${i === crumbs.length - 1 ? 'current' : ''}`
  }, c)))), /*#__PURE__*/React.createElement("div", {
    className: "hub-header__search"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 14,
    className: "hub-search-icon"
  }), /*#__PURE__*/React.createElement("input", {
    type: "text",
    placeholder: "Search ASINs, SKUs, vendors\u2026"
  })), /*#__PURE__*/React.createElement("div", {
    className: "hub-header__actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "hub-icon-btn",
    title: "Notifications"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "bell",
    size: 18
  }), /*#__PURE__*/React.createElement("span", {
    className: "dot"
  })), /*#__PURE__*/React.createElement("button", {
    className: "hub-icon-btn",
    title: "Help"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "help",
    size: 18
  }))));
}
window.Header = Header;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/hub/hub-header.jsx", error: String((e && e.message) || e) }); }

// ui_kits/hub/hub-icon.jsx
try { (() => {
// Icon.jsx — shared SVG icon set for the Hub UI kit.
// Outline, 2px stroke, currentColor. 16px default.

const ICONS = {
  search: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "11",
    cy: "11",
    r: "7"
  }), /*#__PURE__*/React.createElement("path", {
    d: "m21 21-4.3-4.3"
  })),
  menu: /*#__PURE__*/React.createElement("path", {
    d: "M3 6h18M6 12h12M10 18h4"
  }),
  plus: /*#__PURE__*/React.createElement("path", {
    d: "M12 5v14M5 12h14"
  }),
  close: /*#__PURE__*/React.createElement("path", {
    d: "M18 6 6 18M6 6l12 12"
  }),
  check: /*#__PURE__*/React.createElement("path", {
    d: "m5 12 5 5L20 7"
  }),
  chevronRight: /*#__PURE__*/React.createElement("path", {
    d: "m9 6 6 6-6 6"
  }),
  chevronLeft: /*#__PURE__*/React.createElement("path", {
    d: "m15 6-6 6 6 6"
  }),
  chevronDown: /*#__PURE__*/React.createElement("path", {
    d: "m6 9 6 6 6-6"
  }),
  bell: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M13.73 21a2 2 0 0 1-3.46 0"
  })),
  help: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "10"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 17h.01"
  })),
  grid: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "3",
    width: "7",
    height: "7",
    rx: "1"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "14",
    y: "3",
    width: "7",
    height: "7",
    rx: "1"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "14",
    width: "7",
    height: "7",
    rx: "1"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "14",
    y: "14",
    width: "7",
    height: "7",
    rx: "1"
  })),
  list: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M8 6h13M8 12h13M8 18h13"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M3 6h.01M3 12h.01M3 18h.01"
  })),
  filter: /*#__PURE__*/React.createElement("path", {
    d: "M22 3H2l8 9.46V19l4 2v-8.54L22 3z"
  }),
  download: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"
  }), /*#__PURE__*/React.createElement("path", {
    d: "m7 10 5 5 5-5"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 15V3"
  })),
  dots: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "5",
    cy: "12",
    r: "1.5"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "1.5"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "19",
    cy: "12",
    r: "1.5"
  })),
  package: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M21 8v13H3V8"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M1 3h22v5H1z"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M10 12h4"
  })),
  target: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "10"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "6"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "2"
  })),
  barChart: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M12 20V10M18 20V4M6 20v-4"
  })),
  keyword: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M3 7h18M3 12h12M3 17h18"
  })),
  dollar: /*#__PURE__*/React.createElement("path", {
    d: "M12 1v22M17 5H9.5a3.5 3.5 0 1 0 0 7h5a3.5 3.5 0 1 1 0 7H6"
  }),
  copyright: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "10"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M14.83 9.17a4 4 0 1 0 0 5.66"
  })),
  box: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"
  }), /*#__PURE__*/React.createElement("path", {
    d: "m3.27 6.96 8.73 5.05 8.73-5.05"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 22.08V12"
  })),
  vendor: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M3 21h18"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M5 21V7l8-4v18"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M19 21V11l-6-4"
  })),
  settings: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
  })),
  external: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M15 3h6v6"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M10 14 21 3"
  })),
  arrowUp: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "m5 12 7-7 7 7"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 19V5"
  }))
};
function Icon({
  name,
  size = 16,
  stroke = 2,
  className = '',
  style = {}
}) {
  const content = ICONS[name];
  if (!content) return null;
  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: stroke,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    className: className,
    style: style,
    "aria-hidden": "true"
  }, content);
}
window.Icon = Icon;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/hub/hub-icon.jsx", error: String((e && e.message) || e) }); }

// ui_kits/hub/hub-sidebar.jsx
try { (() => {
// Sidebar.jsx — grouped app navigation for 1000 Miles Hub.

function Sidebar({
  activeKey,
  onNavigate,
  collapsed
}) {
  const groups = [{
    label: 'Amazon',
    items: [{
      key: 'listings',
      label: 'Listings',
      icon: 'grid',
      badge: '128'
    }, {
      key: 'ppc',
      label: 'PPC Campaigns',
      icon: 'target'
    }, {
      key: 'keywords',
      label: 'Keyword Research',
      icon: 'keyword'
    }, {
      key: 'analytics',
      label: 'ACOS Analytics',
      icon: 'barChart'
    }]
  }, {
    label: 'OEM',
    items: [{
      key: 'vendors',
      label: 'Vendors',
      icon: 'vendor'
    }, {
      key: 'pricing',
      label: 'Pricing',
      icon: 'dollar'
    }, {
      key: 'copyright',
      label: 'Copyright',
      icon: 'copyright'
    }]
  }, {
    label: 'Nexus',
    items: [{
      key: 'products',
      label: 'Products',
      icon: 'box'
    }, {
      key: 'tools',
      label: 'Tooling',
      icon: 'package'
    }]
  }];
  return /*#__PURE__*/React.createElement("aside", {
    className: `hub-sidebar ${collapsed ? 'collapsed' : ''}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-sidebar__header"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-logo-tile"
  }, "1000M"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "hub-sidebar__name"
  }, "1000 Miles Hub"), /*#__PURE__*/React.createElement("div", {
    className: "hub-sidebar__sub"
  }, "ops.internal"))), /*#__PURE__*/React.createElement("nav", {
    className: "hub-sidebar__nav"
  }, groups.map(group => /*#__PURE__*/React.createElement("div", {
    key: group.label,
    className: "hub-sidebar__group"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-sidebar__group-label"
  }, group.label), group.items.map(item => /*#__PURE__*/React.createElement("button", {
    key: item.key,
    className: `hub-sidebar__item ${activeKey === item.key ? 'active' : ''}`,
    onClick: () => onNavigate && onNavigate(item.key),
    title: item.label
  }, /*#__PURE__*/React.createElement(Icon, {
    name: item.icon,
    size: 16,
    className: "hub-sidebar__icon"
  }), /*#__PURE__*/React.createElement("span", {
    className: "hub-sidebar__label"
  }, item.label), item.badge && /*#__PURE__*/React.createElement("span", {
    className: `hub-sidebar__badge ${activeKey === item.key ? '' : 'muted'}`
  }, item.badge)))))), /*#__PURE__*/React.createElement("div", {
    className: "hub-sidebar__footer"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-user"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-user__avatar"
  }, "MR"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "hub-user__name"
  }, "Maria R."), /*#__PURE__*/React.createElement("div", {
    className: "hub-user__meta"
  }, "Amazon \xB7 BSCOOL")))));
}
window.Sidebar = Sidebar;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/hub/hub-sidebar.jsx", error: String((e && e.message) || e) }); }

// ui_kits/hub/listing-wizard.jsx
try { (() => {
// ListingWizard.jsx — the signature "Create New Product Listing" multi-step flow.

function ListingWizard({
  onClose,
  onPublish
}) {
  const [step, setStep] = React.useState(0);
  const steps = ['Basic Info', 'Pricing', 'Keywords', 'Review'];
  const [form, setForm] = React.useState({
    asin: 'B09FL9KRY4',
    sku: 'BSC-SDU-001',
    title: 'Sticker Dress Up Book — Fashion Girls',
    brand: 'BSCOOL',
    category: 'Toys & Games',
    price: '12.99',
    cost: '3.85',
    fbaFee: 'Auto',
    keywords: 'sticker book girls, dress up stickers, reusable sticker book'
  });
  const set = k => e => setForm({
    ...form,
    [k]: e.target.value
  });
  const next = () => setStep(Math.min(step + 1, steps.length - 1));
  const back = () => setStep(Math.max(step - 1, 0));
  const canPublish = step === steps.length - 1;
  return /*#__PURE__*/React.createElement("div", {
    className: "hub-modal-scrim",
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-modal",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-modal__header"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    className: "hub-modal__title"
  }, "Create New Product Listing"), /*#__PURE__*/React.createElement("p", {
    className: "hub-modal__sub"
  }, "Complete all steps to publish your product to Amazon")), /*#__PURE__*/React.createElement("button", {
    className: "hub-modal__close",
    onClick: onClose
  }, "\xD7")), /*#__PURE__*/React.createElement("div", {
    className: "hub-modal__body"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-stepper"
  }, steps.map((label, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: `hub-step ${i < step ? 'done' : ''} ${i === step ? 'active' : ''}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-step__circle"
  }, i < step ? '✓' : i + 1), /*#__PURE__*/React.createElement("div", {
    className: "hub-step__label"
  }, label)))), step === 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "hub-field-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-field"
  }, /*#__PURE__*/React.createElement("label", {
    className: "hub-field__label"
  }, "ASIN ", /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*")), /*#__PURE__*/React.createElement("input", {
    className: "hub-input",
    value: form.asin,
    onChange: set('asin')
  }), /*#__PURE__*/React.createElement("div", {
    className: "hub-field__hint"
  }, "10-character Amazon Standard ID")), /*#__PURE__*/React.createElement("div", {
    className: "hub-field"
  }, /*#__PURE__*/React.createElement("label", {
    className: "hub-field__label"
  }, "SKU ", /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*")), /*#__PURE__*/React.createElement("input", {
    className: "hub-input",
    value: form.sku,
    onChange: set('sku')
  }), /*#__PURE__*/React.createElement("div", {
    className: "hub-field__hint"
  }, "Your internal stock-keeping unit"))), /*#__PURE__*/React.createElement("div", {
    className: "hub-field"
  }, /*#__PURE__*/React.createElement("label", {
    className: "hub-field__label"
  }, "Product Title ", /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*")), /*#__PURE__*/React.createElement("input", {
    className: "hub-input",
    value: form.title,
    onChange: set('title')
  }), /*#__PURE__*/React.createElement("div", {
    className: "hub-field__hint"
  }, "Up to 200 characters. Include brand + primary keyword.")), /*#__PURE__*/React.createElement("div", {
    className: "hub-field-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-field"
  }, /*#__PURE__*/React.createElement("label", {
    className: "hub-field__label"
  }, "Brand"), /*#__PURE__*/React.createElement("select", {
    className: "hub-select",
    value: form.brand,
    onChange: set('brand')
  }, ['BSCOOL', 'Popcraze', 'Presparo', 'Liladora'].map(b => /*#__PURE__*/React.createElement("option", {
    key: b
  }, b)))), /*#__PURE__*/React.createElement("div", {
    className: "hub-field"
  }, /*#__PURE__*/React.createElement("label", {
    className: "hub-field__label"
  }, "Category"), /*#__PURE__*/React.createElement("select", {
    className: "hub-select",
    value: form.category,
    onChange: set('category')
  }, /*#__PURE__*/React.createElement("option", null, "Toys & Games"), /*#__PURE__*/React.createElement("option", null, "Arts & Crafts"), /*#__PURE__*/React.createElement("option", null, "Office Products"))))), step === 1 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "hub-field-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-field"
  }, /*#__PURE__*/React.createElement("label", {
    className: "hub-field__label"
  }, "Sale Price (USD) ", /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*")), /*#__PURE__*/React.createElement("input", {
    className: "hub-input",
    value: form.price,
    onChange: set('price')
  }), /*#__PURE__*/React.createElement("div", {
    className: "hub-field__hint"
  }, "MAP enforced at $10.99")), /*#__PURE__*/React.createElement("div", {
    className: "hub-field"
  }, /*#__PURE__*/React.createElement("label", {
    className: "hub-field__label"
  }, "Landed Cost (USD)"), /*#__PURE__*/React.createElement("input", {
    className: "hub-input",
    value: form.cost,
    onChange: set('cost')
  }), /*#__PURE__*/React.createElement("div", {
    className: "hub-field__hint"
  }, "Factory + inbound freight + duty"))), /*#__PURE__*/React.createElement("div", {
    className: "hub-field-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-field"
  }, /*#__PURE__*/React.createElement("label", {
    className: "hub-field__label"
  }, "FBA Fee (estimated)"), /*#__PURE__*/React.createElement("input", {
    className: "hub-input",
    value: form.fbaFee,
    disabled: true
  }), /*#__PURE__*/React.createElement("div", {
    className: "hub-field__hint"
  }, "Auto-calculated from weight & size tier")), /*#__PURE__*/React.createElement("div", {
    className: "hub-field"
  }, /*#__PURE__*/React.createElement("label", {
    className: "hub-field__label"
  }, "Referral Fee"), /*#__PURE__*/React.createElement("input", {
    className: "hub-input",
    value: "15%",
    disabled: true
  }), /*#__PURE__*/React.createElement("div", {
    className: "hub-field__hint"
  }, "15% of sale price for Toys & Games."))), /*#__PURE__*/React.createElement("div", {
    className: "hub-alert hub-alert--info"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "target",
    size: 16
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "hub-alert__title"
  }, "Estimated margin: 38%"), /*#__PURE__*/React.createElement("div", null, "Gross profit $4.90 per unit after Amazon fees.")))), step === 2 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "hub-field"
  }, /*#__PURE__*/React.createElement("label", {
    className: "hub-field__label"
  }, "Search Terms (Backend Keywords) ", /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*")), /*#__PURE__*/React.createElement("textarea", {
    className: "hub-textarea",
    value: form.keywords,
    onChange: set('keywords')
  }), /*#__PURE__*/React.createElement("div", {
    className: "hub-field__hint"
  }, "Hidden keywords \u2014 max 250 bytes, no repetition.")), /*#__PURE__*/React.createElement("div", {
    className: "hub-field"
  }, /*#__PURE__*/React.createElement("label", {
    className: "hub-field__label"
  }, "Suggested Keywords"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6
    }
  }, ['reusable stickers', 'sticker book for girls', 'dress up activity', 'travel activity book', 'busy book kids'].map(k => /*#__PURE__*/React.createElement("span", {
    key: k,
    className: "hub-chip",
    style: {
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "plus",
    size: 10
  }), " ", k))))), step === 3 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "hub-alert hub-alert--success",
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "check",
    size: 16
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "hub-alert__title"
  }, "Ready to publish"), /*#__PURE__*/React.createElement("div", null, "All required fields are complete. Click 'Publish Listing' to go live on Amazon."))), /*#__PURE__*/React.createElement("div", {
    className: "hub-card",
    style: {
      boxShadow: 'none',
      border: '1px solid var(--border)'
    }
  }, [['ASIN', form.asin], ['SKU', form.sku], ['Title', form.title], ['Brand', form.brand], ['Category', form.category], ['Sale Price', `$${form.price}`], ['Landed Cost', `$${form.cost}`], ['Keywords', form.keywords]].map(([k, v]) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      display: 'flex',
      gap: 16,
      padding: '6px 0',
      borderBottom: '1px solid var(--border)',
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 120,
      color: 'var(--fg2)',
      fontWeight: 600
    }
  }, k), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, v)))))), /*#__PURE__*/React.createElement("div", {
    className: "hub-modal__footer"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn--ghost"
  }, "Save as Draft"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, step > 0 && /*#__PURE__*/React.createElement("button", {
    className: "btn btn--outline",
    onClick: back
  }, "\u2039 Back"), !canPublish && /*#__PURE__*/React.createElement("button", {
    className: "btn",
    onClick: next
  }, "Next: ", steps[step + 1], " \u203A"), canPublish && /*#__PURE__*/React.createElement("button", {
    className: "btn",
    onClick: onPublish
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "check",
    size: 14
  }), " Publish Listing")))));
}
window.ListingWizard = ListingWizard;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/hub/listing-wizard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/hub/listings-page.jsx
try { (() => {
// ListingsPage.jsx — Amazon listings table (the default Hub landing page).

function StatusBadge({
  status
}) {
  const map = {
    LIVE: 'badge--live',
    DRAFT: 'badge--draft',
    ARCHIVED: 'badge--archived',
    WARNING: 'badge--warning'
  };
  return /*#__PURE__*/React.createElement("span", {
    className: `badge ${map[status] || 'badge--draft'}`
  }, status);
}
const LISTINGS = [{
  asin: 'B09FL9KRY4',
  title: 'Sticker Dress Up Book — Fashion Girls',
  sku: 'BSC-SDU-001',
  brand: 'BSCOOL',
  status: 'LIVE',
  price: 12.99,
  acos: 24,
  spend: 1240,
  img: null
}, {
  asin: 'B0CT4M2XXX',
  title: 'Kids Activity Pad — Mermaid Edition',
  sku: 'POP-KAP-012',
  brand: 'Popcraze',
  status: 'LIVE',
  price: 14.99,
  acos: 31,
  spend: 980,
  img: null
}, {
  asin: 'B0D7JNXXXX',
  title: 'Reusable Sticker Set, 200pc — Dinosaurs',
  sku: 'BSC-RSS-044',
  brand: 'BSCOOL',
  status: 'DRAFT',
  price: 9.49,
  acos: null,
  spend: 0,
  img: null
}, {
  asin: 'B0BZVFXXXX',
  title: 'Coloring Book, Unicorn Forest — Large',
  sku: 'PRE-CBU-003',
  brand: 'Presparo',
  status: 'LIVE',
  price: 8.99,
  acos: 18,
  spend: 640,
  img: null
}, {
  asin: 'B0CM6QXXXX',
  title: 'Puffy Sticker Activity, Ocean',
  sku: 'LIL-PSA-021',
  brand: 'Liladora',
  status: 'WARNING',
  price: 11.49,
  acos: 42,
  spend: 1820,
  img: null
}, {
  asin: 'B0C3YTXXXX',
  title: 'Travel Drawing Pad with Markers',
  sku: 'BSC-TDP-008',
  brand: 'BSCOOL',
  status: 'LIVE',
  price: 18.99,
  acos: 22,
  spend: 2140,
  img: null
}, {
  asin: 'B09VRTXXXX',
  title: 'Mini Sticker Book — Cats & Dogs',
  sku: 'POP-MSB-017',
  brand: 'Popcraze',
  status: 'ARCHIVED',
  price: 6.99,
  acos: null,
  spend: 0,
  img: null
}];
function ListingsPage({
  onNew,
  selectedId,
  onSelect
}) {
  const [brandFilter, setBrandFilter] = React.useState('All');
  const [tab, setTab] = React.useState('all');
  const brands = ['All', 'BSCOOL', 'Popcraze', 'Presparo', 'Liladora'];
  const filtered = LISTINGS.filter(l => {
    if (brandFilter !== 'All' && l.brand !== brandFilter) return false;
    if (tab === 'live' && l.status !== 'LIVE') return false;
    if (tab === 'drafts' && l.status !== 'DRAFT') return false;
    if (tab === 'issues' && l.status !== 'WARNING') return false;
    return true;
  });
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "hub-page-title"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", null, "Listings"), /*#__PURE__*/React.createElement("p", null, "Amazon product catalog across all 4 brands \xB7 updated 2 min ago")), /*#__PURE__*/React.createElement("div", {
    className: "hub-page-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn--outline"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "download",
    size: 14
  }), " Export"), /*#__PURE__*/React.createElement("button", {
    className: "btn",
    onClick: onNew
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "plus",
    size: 14
  }), " New Listing"))), /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi__label"
  }, "Total Listings"), /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi__value"
  }, "128"), /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi__delta up"
  }, "\u25B2 4 this week")), /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi__label"
  }, "Avg. ACOS"), /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi__value"
  }, "26%"), /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi__delta down"
  }, "\u25BC 1.2pt vs. last wk")), /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi__label"
  }, "Ad Spend \xB7 7d"), /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi__value"
  }, "$6,820"), /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi__delta up"
  }, "\u25B2 8%")), /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi__label"
  }, "Issues"), /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi__value",
    style: {
      color: 'var(--color-warning)'
    }
  }, "3"), /*#__PURE__*/React.createElement("div", {
    className: "hub-kpi__delta",
    style: {
      color: 'var(--fg2)'
    }
  }, "2 ACOS \xB7 1 stock"))), /*#__PURE__*/React.createElement("div", {
    className: "hub-tabs"
  }, [{
    k: 'all',
    l: 'All'
  }, {
    k: 'live',
    l: 'Live'
  }, {
    k: 'drafts',
    l: 'Drafts'
  }, {
    k: 'issues',
    l: 'Needs Attention'
  }].map(t => /*#__PURE__*/React.createElement("button", {
    key: t.k,
    className: `hub-tab ${tab === t.k ? 'active' : ''}`,
    onClick: () => setTab(t.k)
  }, t.l))), /*#__PURE__*/React.createElement("div", {
    className: "hub-toolbar"
  }, brands.map(b => /*#__PURE__*/React.createElement("button", {
    key: b,
    className: `hub-chip ${brandFilter === b ? 'active' : ''}`,
    onClick: () => setBrandFilter(b)
  }, b)), /*#__PURE__*/React.createElement("div", {
    className: "sep"
  }), /*#__PURE__*/React.createElement("button", {
    className: "hub-chip"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "filter",
    size: 12
  }), " Filters"), /*#__PURE__*/React.createElement("div", {
    className: "spacer"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--fg2)'
    }
  }, filtered.length, " of ", LISTINGS.length, " items")), /*#__PURE__*/React.createElement("div", {
    className: "hub-table-wrap"
  }, /*#__PURE__*/React.createElement("table", {
    className: "hub-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: 56
    }
  }), /*#__PURE__*/React.createElement("th", null, "Product"), /*#__PURE__*/React.createElement("th", null, "Brand"), /*#__PURE__*/React.createElement("th", null, "Status"), /*#__PURE__*/React.createElement("th", {
    className: "num"
  }, "Price"), /*#__PURE__*/React.createElement("th", {
    className: "num"
  }, "ACOS"), /*#__PURE__*/React.createElement("th", {
    className: "num"
  }, "Ad Spend \xB7 7d"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: 40
    }
  }))), /*#__PURE__*/React.createElement("tbody", null, filtered.map(l => /*#__PURE__*/React.createElement("tr", {
    key: l.asin,
    className: selectedId === l.asin ? 'selected' : '',
    onClick: () => onSelect && onSelect(l.asin)
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    className: "td-img"
  }, "IMG")), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("div", {
    className: "title"
  }, l.title), /*#__PURE__*/React.createElement("div", {
    className: "subtitle"
  }, /*#__PURE__*/React.createElement("span", {
    className: "asin"
  }, l.asin), " \xB7 ", l.sku)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "badge badge--brand"
  }, l.brand)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(StatusBadge, {
    status: l.status
  })), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, "$", l.price.toFixed(2)), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, l.acos != null ? `${l.acos}%` : '—'), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, l.spend > 0 ? `$${l.spend.toLocaleString()}` : '—'), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("button", {
    className: "hub-icon-btn",
    style: {
      width: 28,
      height: 28
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "dots",
    size: 14
  })))))))));
}
window.ListingsPage = ListingsPage;
window.StatusBadge = StatusBadge;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/hub/listings-page.jsx", error: String((e && e.message) || e) }); }

})();
