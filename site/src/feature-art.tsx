import { useId, useState, type PointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArchiveIcon, ArrowRightIcon, BoxIcon, CheckIcon, ChevronsLeftRightIcon, Columns2Icon, FileCode2Icon, FolderIcon, GitBranchIcon, GitCommitHorizontalIcon, GitPullRequestArrowIcon, HistoryIcon, ImageIcon, MoonIcon, SunIcon } from "lucide-react";
import { DiffCode } from "@/components/diff-code";
import { GitHubMark } from "@/components/github-mark";
import { Button } from "@/components/ui/button";
import { VcsIcon } from "@/components/vcs-icon";
import { demoFiles } from "./demo-data";
import { fileChangeIds, projectDemoDiff } from "./demo-model";
import { TechnologyMark } from "./technology-mark";
import { useSiteTheme } from "./theme";
import { useArtMotion } from "./use-art-motion";

const specimen = demoFiles.find(file => file.id === "navigation")!;
const specimenDiff = projectDemoDiff(specimen, new Set(), new Set(fileChangeIds(specimen))).diff;

function Artwork({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <svg xmlns="http://www.w3.org/2000/svg" className={`story-svg ${className}`} width="680" height="460" viewBox="0 0 680 460" fill="none" xmlSpace="preserve" aria-hidden="true" focusable="false">{children}</svg>;
}

export function DesignScene() {
  const { t } = useTranslation();
  const { theme, setTheme } = useSiteTheme();
  return <div className="design-stage">
    <div className="design-specimen">
      <div aria-hidden="true" inert translate="no" className="design-specimen-content">
        <div className="design-specimen-title"><span className="design-window-dots"><i /><i /><i /></span><VcsIcon vcs="git" /><span>atlas</span><span className="design-title-branch">main</span></div>
        <div className="design-specimen-body"><div className="design-specimen-sidebar"><GitCommitHorizontalIcon /><HistoryIcon /><ArchiveIcon /><GitBranchIcon /></div><div className="design-specimen-code"><div className="design-file-heading"><span className="design-file-status">M</span><span>{specimen.path}</span><Columns2Icon /></div><DiffCode diff={specimenDiff} /></div></div>
      </div>
      <div className="design-specimen-controls site-art-controls"><span>{t("story.design.theme")}</span><div role="group" aria-label={t("story.design.theme")}><Button type="button" size="sm" variant={theme === "light" ? "secondary" : "ghost"} aria-pressed={theme === "light"} onClick={() => setTheme("light")}><SunIcon />{t("theme.light")}</Button><Button type="button" size="sm" variant={theme === "dark" ? "secondary" : "ghost"} aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}><MoonIcon />{t("theme.dark")}</Button></div></div>
    </div>
  </div>;
}

export function RustScene() {
  const { ref: architectureRef, playing } = useArtMotion();
  const id = useId();
  return <div className="architecture-stage" ref={architectureRef} data-playing={playing}>
    <Artwork className="architecture-art">
      <defs><linearGradient id={`${id}-chip`} x1="252" y1="156" x2="424" y2="306" gradientUnits="userSpaceOnUse"><stop stopColor="var(--art-metal-high)" /><stop offset=".5" stopColor="var(--art-metal-low)" /><stop offset="1" stopColor="var(--art-metal-mid)" /></linearGradient></defs>
      <g className="architecture-board"><path d="M78 62H220L250 92H602M78 398H220L250 368H602M114 62V88M570 62V88M114 374V398M570 374V398" /><path d="M192 56H202M192 404H202M478 56H488M478 404H488" /></g>
      <g className="architecture-traces"><path d="M152 126H192Q200 126 200 134V204Q200 212 208 212H248M152 334H192Q200 334 200 326V256Q200 248 208 248H248M432 212H472Q480 212 480 204V134Q480 126 488 126H532M432 248H472Q480 248 480 256V326Q480 334 488 334H532" /></g>
      <rect x="248" y="148" width="184" height="164" rx="16" className="architecture-chip-base" />
      <rect x="254" y="154" width="172" height="152" rx="11" fill={`url(#${id}-chip)`} className="architecture-chip-face" />
      <rect x="264" y="164" width="152" height="132" rx="5" className="architecture-chip-inset" />
      <g className="architecture-core"><TechnologyMark name="rust" x="299" y="189" width="82" height="82" /></g>
      {[0,1,2,3,4].map(index => <g key={index} className="architecture-pins"><path d={`M238 ${182+index*24}H248M432 ${182+index*24}H442`} /></g>)}
      <g className="architecture-nodes"><rect x="76" y="88" width="76" height="76" rx="14" /><rect x="76" y="296" width="76" height="76" rx="14" /><rect x="532" y="88" width="76" height="76" rx="14" /><rect x="532" y="296" width="76" height="76" rx="14" /></g>
      <TechnologyMark name="react" x="95" y="107" width="38" height="38" /><TechnologyMark name="tauri" x="96" y="316" width="36" height="36" /><VcsIcon vcs="git" x="553" y="109" width="34" height="34" /><VcsIcon vcs="perforce" x="552" y="316" width="36" height="36" />
      <g transform="translate(152 126)"><g className="architecture-signal architecture-in-high"><circle r="3" /></g></g>
      <g transform="translate(152 334)"><g className="architecture-signal architecture-in-low"><circle r="3" /></g></g>
      <g transform="translate(432 212)"><g className="architecture-signal architecture-out-high"><circle r="3" /></g></g>
      <g transform="translate(432 248)"><g className="architecture-signal architecture-out-low"><circle r="3" /></g></g>
    </Artwork>
  </div>;
}

export function OperationsScene() {
  const { t } = useTranslation();
  const sets = [{vcs: "git" as const, title: "Git", x: 28, y: 30, icons: [GitCommitHorizontalIcon, GitBranchIcon, GitPullRequestArrowIcon], labels: ["gitReview", "gitBranch", "gitRebase"]}, {vcs: "perforce" as const, title: "Perforce", x: 210, y: 242, icons: [FileCode2Icon, BoxIcon, GitPullRequestArrowIcon], labels: ["p4Changes", "p4Shelves", "p4Resolve"]}];
  return <Artwork>{sets.map(({vcs,title,x,y,icons,labels}) => <g key={vcs} transform={`translate(${x} ${y})`}>
    <rect width="440" height="190" rx="10" className="story-panel" /><path d="M0 48H440" className="story-wires" />
    <VcsIcon vcs={vcs} x="22" y="14" width="22" height="22" /><text x="56" y="30" className="story-label">{title}</text>
    {icons.map((Icon,index) => <g key={labels[index]}><Icon x="24" y={66+index*38} width="18" height="18" className="story-muted" /><text x="58" y={80+index*38} className="story-operation-label">{t(`story.art.${labels[index]}`)}</text><CheckIcon x="396" y={66+index*38} width="16" height="16" className="story-check" /></g>)}
  </g>)}</Artwork>;
}

function Pine({ x, y, height = 64 }: {x: number; y: number; height?: number}) {
  return <g transform={`translate(${x} ${y})`}><path d={`M0 0V${height*.2}`} stroke="var(--art-tree-trunk)" strokeWidth="3" /><path d={`M0 ${-height} ${height*.31} 0 0 ${height*.12} ${-height*.31} 0Z`} fill="var(--art-tree-right)" stroke="var(--art-tree-edge)" strokeWidth=".65" /><path d={`M0 ${-height}V${height*.12}L${-height*.31} 0Z`} fill="var(--art-tree-left)" /><path d={`M0 ${-height*.7} ${height*.36} ${height*.08} 0 ${height*.24} ${-height*.36} ${height*.08}Z`} fill="var(--art-tree-right)" stroke="var(--art-tree-edge)" strokeWidth=".65" /><path d={`M0 ${-height*.7}V${height*.24}L${-height*.36} ${height*.08}Z`} fill="var(--art-tree-left)" /></g>;
}

function ForestImage({ revision }: {revision: "before" | "after"}) {
  const id = useId();
  return <svg viewBox="0 0 680 340" width="680" height="340" fill="none" aria-hidden="true" className="forest-image">
    <defs><linearGradient id={`${id}-ground`} x1="178" y1="108" x2="508" y2="292" gradientUnits="userSpaceOnUse"><stop stopColor="var(--art-ground-high)" /><stop offset="1" stopColor="var(--art-ground-low)" /></linearGradient></defs>
    <ellipse cx="342" cy="282" rx="248" ry="24" fill="var(--art-ground-shadow)" />
    <path d="m64 202 276 126 276-118v12L340 340 64 214Z" fill="var(--art-ground-edge)" />
    <path d="m340 76 276 134-276 118L64 202Z" fill={`url(#${id}-ground)`} stroke="var(--art-ground-line)" />
    <g className="forest-grid">{[1,2,3,4,5].map(n => <g key={n}><path d={`M${340-n*46} ${76+n*21}L${616-n*46} ${210+n*19.7}`} /><path d={`M${340+n*46} ${76+n*22.3}L${64+n*46} ${202+n*21}`} /></g>)}</g>
    <path d="m366 152 56 28v65l-56 27-56-28v-65Z" fill="var(--art-stone-left)" stroke="var(--art-stone-edge)" /><path d="m310 179 56-27 56 28-56 28Z" fill="var(--art-stone-top)" /><path d="m366 208 56-28v65l-56 27Z" fill="var(--art-stone-right)" />
    <Pine x={242} y={190} height={72} /><Pine x={172} y={222} height={54} /><Pine x={444} y={256} height={50} />
    {revision === "after" ? <g className="forest-change"><Pine x={308} y={278} height={60} /><Pine x={492} y={202} height={64} /></g> : null}
    <path d="m340 76 276 134-276 118L64 202Z" stroke="var(--art-ground-line)" />
  </svg>;
}

export function GamesScene() {
  const { t, i18n } = useTranslation();
  const [position, setPosition] = useState(50);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const format = new Intl.NumberFormat(i18n.resolvedLanguage ?? "en");

  function followPointer(event: PointerEvent<HTMLInputElement>) {
    const { left, width } = event.currentTarget.getBoundingClientRect();
    setPosition(Math.round(Math.max(0, Math.min(100, (event.clientX - left) / width * 100))));
  }

  function startComparison(event: PointerEvent<HTMLInputElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    setKeyboardFocus(false);
    event.currentTarget.setPointerCapture(event.pointerId);
    followPointer(event);
  }

  function moveComparison(event: PointerEvent<HTMLInputElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) followPointer(event);
  }

  function endComparison(event: PointerEvent<HTMLInputElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    followPointer(event);
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return <div className="asset-stage" onPointerDownCapture={() => setKeyboardFocus(false)}><div className="asset-review">
    <div className="asset-review-heading"><ImageIcon aria-hidden="true" /><span translate="no">Textures/Forest.png</span><span className="asset-modified">M</span></div>
    <div className="asset-image-stage" data-keyboard-focus={keyboardFocus}><div className="asset-image-content" role="img" aria-label={t("story.games.imageDescription")}>
      <div className="asset-image-layer"><ForestImage revision="before" /></div>
      <div className="asset-image-layer" style={{clipPath: `inset(0 0 0 ${position}%)`}}><ForestImage revision="after" /></div>
      <span className="asset-revision-tag asset-revision-before" style={{opacity: position > 0 ? 1 : 0}} translate="no" aria-hidden="true">CL #41</span><span className="asset-revision-tag asset-revision-after" style={{opacity: position < 100 ? 1 : 0}} translate="no" aria-hidden="true">CL #42</span>
      <div className="asset-comparison-divider" style={{left: `${position}%`}} aria-hidden="true"><span><ChevronsLeftRightIcon /></span></div>
      </div><input type="range" name="asset-revision-comparison" autoComplete="off" min="0" max="100" value={position} aria-label={t("story.games.swipe")} aria-valuetext={t("story.games.swipePosition",{before:format.format(position),after:format.format(100-position)})} className="asset-comparison-input site-art-controls" onFocus={event => setKeyboardFocus(event.currentTarget.matches(":focus-visible"))} onBlur={() => setKeyboardFocus(false)} onKeyDown={() => setKeyboardFocus(true)} onPointerDown={startComparison} onPointerMove={moveComparison} onPointerUp={endComparison} onChange={event => setPosition(Number(event.target.value))} />
    </div>
    <div className="asset-review-controls site-art-controls"><span className="asset-review-provider"><VcsIcon vcs="perforce" /><span>{t("story.games.revisions")}</span></span><div role="group" aria-label={t("story.games.revisions")}><Button type="button" size="sm" variant={position === 100 ? "secondary" : "ghost"} onClick={() => setPosition(100)}>{t("story.games.before")}</Button><ArrowRightIcon aria-hidden="true" /><Button type="button" size="sm" variant={position === 0 ? "secondary" : "ghost"} onClick={() => setPosition(0)}>{t("story.games.after")}</Button></div></div>
  </div></div>;
}

export function SourceScene() {
  const { t } = useTranslation();
  return <div className="source-stage" aria-hidden="true" translate="no"><div className="source-repository">
    <div className="source-repository-heading"><GitHubMark /><span>RebaseRaven</span><span className="source-license-badge">MIT</span></div>
    <div className="source-repository-tree">
      <div><span className="source-tree-branch" /><FolderIcon /><span>src/</span><span>TypeScript</span></div>
      <div><span className="source-tree-branch" /><FolderIcon /><span>src-tauri/</span><span>Rust</span></div>
      <div><span className="source-tree-branch" /><FolderIcon /><span>site/</span><span>React</span></div>
      <div><span className="source-tree-branch" /><FileCode2Icon /><span>LICENSE</span><span>MIT License</span></div>
    </div>
    <div className="source-repository-footer"><GitBranchIcon /><span>dev</span><CheckIcon /><span>{t("story.source.public")}</span></div>
  </div></div>;
}
