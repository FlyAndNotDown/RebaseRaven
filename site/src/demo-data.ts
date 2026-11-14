export type DemoLine = {
  oldNumber?: number;
  newNumber?: number;
  before?: string;
  after?: string;
};

export type DemoHunk = {
  id: string;
  header: string;
  lines: DemoLine[];
};

export type DemoFile = {
  id: string;
  path: string;
  status: "A" | "M";
  hunks: DemoHunk[];
};

export const demoFiles: DemoFile[] = [
  {
    id: "navigation",
    path: "src/navigation.ts",
    status: "M",
    hunks: [
      {
        id: "navigation-wrap",
        header: "@@ -12,3 +12,4 @@",
        lines: [
          {"oldNumber": 12, "before": "export type View = 'changes' | 'history' | 'files';", "newNumber": 12, "after": "export type View = 'changes' | 'history' | 'files';"},
          {"oldNumber": 13, "before": "", "newNumber": 13, "after": ""},
          {"oldNumber": 14, "before": "const views: View[] = ['changes', 'history', 'files'];", "newNumber": 14, "after": "const views: View[] = ['changes', 'history', 'files'];"},
          {"oldNumber": 15, "before": "", "newNumber": 15, "after": ""},
          {"oldNumber": 16, "before": "export function nextView(current: View) {", "newNumber": 16, "after": "export function nextView(current: View) {"},
          {"oldNumber": 17, "before": "  return views[current + 1];", "newNumber": 17, "after": "  const index = views.indexOf(current);"},
          {"newNumber": 18, "after": "  return views[(index + 1) % views.length];"},
          {"oldNumber": 18, "before": "}", "newNumber": 19, "after": "}"},
          {"oldNumber": 19, "before": "", "newNumber": 20, "after": ""},
          {"oldNumber": 20, "before": "export function previousView(current: View) {", "newNumber": 21, "after": "export function previousView(current: View) {"},
          {"oldNumber": 21, "before": "  const index = views.indexOf(current);", "newNumber": 22, "after": "  const index = views.indexOf(current);"},
          {"oldNumber": 22, "before": "  return views[(index - 1 + views.length) % views.length];", "newNumber": 23, "after": "  return views[(index - 1 + views.length) % views.length];"},
          {"oldNumber": 23, "before": "}", "newNumber": 24, "after": "}"}
        ],
      },
      {
        id: "navigation-shortcuts",
        header: "@@ -32,2 +33,3 @@",
        lines: [
          { oldNumber: 32, newNumber: 33, before: "export const shortcuts = {", after: "export const shortcuts = {" },
          { newNumber: 34, after: "  nextView: 'Mod+Alt+ArrowRight'," },
          { oldNumber: 33, newNumber: 35, before: "};", after: "};" },
        ],
      },
    ],
  },
  {
    id: "theme",
    path: "src/theme.ts",
    status: "M",
    hunks: [{
      id: "theme-preference",
      header: "@@ -1,3 +1,3 @@",
      lines: [
        { oldNumber: 1, newNumber: 1, before: "export const appearance = {", after: "export const appearance = {" },
        { oldNumber: 2, newNumber: 2, before: "  theme: 'light',", after: "  theme: 'system'," },
        { oldNumber: 3, newNumber: 3, before: "};", after: "};" },
      ],
    }],
  },
  {
    id: "test",
    path: "src/navigation.test.ts",
    status: "A",
    hunks: [{
      id: "navigation-test",
      header: "@@ -0,0 +1,4 @@",
      lines: [
        { newNumber: 1, after: "it('wraps to the first view', () => {" },
        { newNumber: 2, after: "  const last = views[views.length - 1];" },
        { newNumber: 3, after: "  expect(nextView(last)).toBe(views[0]);" },
        { newNumber: 4, after: "});" },
      ],
    }],
  },
  {
    id: "workspace", path: "src/workspace.ts", status: "M",
    hunks: [{ id: "workspace-tab", header: "@@ -8,4 +8,5 @@", lines: [
      { oldNumber: 8, newNumber: 8, before: "export function openWorkspace(path: string) {", after: "export function openWorkspace(path: string) {" },
      { newNumber: 9, after: "  if (tabs.some(tab => tab.path === path)) return;" },
      { oldNumber: 9, newNumber: 10, before: "  tabs.push({ path, view: 'changes' });", after: "  tabs.push({ path, view: 'changes' });" },
      { oldNumber: 10, newNumber: 11, before: "  focusWorkspace(path);", after: "  focusWorkspace(path);" },
      { oldNumber: 11, newNumber: 12, before: "}", after: "}" },
    ] }],
  },
  {
    id: "settings", path: "src/settings.ts", status: "M",
    hunks: [{ id: "settings-keys", header: "@@ -1,3 +1,3 @@", lines: [
      { oldNumber: 1, newNumber: 1, before: "export const settings = {", after: "export const settings = {" },
      { oldNumber: 2, newNumber: 2, before: "  keyboardNavigation: false,", after: "  keyboardNavigation: true," },
      { oldNumber: 3, newNumber: 3, before: "};", after: "};" },
    ] }],
  },
  {
    id: "readme", path: "docs/navigation.md", status: "M",
    hunks: [{ id: "navigation-docs", header: "@@ -1,3 +1,4 @@", lines: [
      { oldNumber: 1, newNumber: 1, before: "# Workspace navigation", after: "# Workspace navigation" },
      { oldNumber: 2, newNumber: 2, before: "", after: "" },
      { oldNumber: 3, newNumber: 3, before: "Select a view in the sidebar.", after: "Select a view in the sidebar." },
      { newNumber: 4, after: "Use Mod+Alt+ArrowRight to cycle through views." },
    ] }],
  },
];

export type DemoCommit = {
  hash: string;
  parents: string[];
  summary: string;
  ref?: string;
  time: string;
  fileIds: string[];
  changeIds?: string[];
  baseChangeIds?: string[];
};

export const demoCommits: DemoCommit[] = [
  { hash: "a6f203d", parents: ["9e72bc1"], summary: "Refine workspace navigation", ref: "main", time: "demo.time.twoMinutes", fileIds: ["navigation", "test"] },
  { hash: "9e72bc1", parents: ["0b73e6f", "c4d810a"], summary: "Merge branch 'feature/search'", time: "demo.time.eighteenMinutes", fileIds: ["navigation"] },
  { hash: "c4d810a", parents: ["0b73e6f"], summary: "Keep search results in view", ref: "feature/search", time: "demo.time.thirtyTwoMinutes", fileIds: ["navigation"] },
  { hash: "0b73e6f", parents: ["d891e3a"], summary: "Follow the system appearance", time: "demo.time.oneHour", fileIds: ["theme"] },
  { hash: "d891e3a", parents: [], summary: "Cover keyboard navigation", time: "demo.time.twoHours", fileIds: ["test"] },
];

export const allHunkIds = demoFiles.flatMap((file) => file.hunks.map((hunk) => hunk.id));

export const p4Changes = [
  { id: "41", summary: "Refine workspace navigation", fileId: "navigation", time: "demo.time.twelveMinutes" },
  { id: "40", summary: "Follow the system appearance", fileId: "theme", time: "demo.time.oneHour" },
  { id: "39", summary: "Cover keyboard navigation", fileId: "test", time: "demo.time.yesterday" },
];
