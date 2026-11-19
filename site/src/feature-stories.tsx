import { useTranslation } from "react-i18next";
import { ArrowUpRightIcon, Code2Icon, CpuIcon, Gamepad2Icon, GitPullRequestArrowIcon, PaletteIcon } from "lucide-react";
import { GitHubMark } from "@/components/github-mark";
import { DesignScene, GamesScene, OperationsScene, RustScene, SourceScene } from "./feature-art";
import { REPOSITORY_URL } from "./release-downloads";

const stories = [
  { id: "design", icon: PaletteIcon, scene: DesignScene },
  { id: "rust", icon: CpuIcon, scene: RustScene },
  { id: "review", icon: GitPullRequestArrowIcon, scene: OperationsScene },
  { id: "games", icon: Gamepad2Icon, scene: GamesScene },
  { id: "source", icon: Code2Icon, scene: SourceScene },
] as const;

export function FeatureStories() {
  const { t } = useTranslation();
  return <div className="site-wrap site-stories">
    <noscript><style>{".site-art-controls { display: none; }"}</style></noscript>
    {stories.map(({ id, icon: Icon, scene: Scene }) => <section className={`site-story site-story-${id}`} key={id} aria-labelledby={`story-${id}`}>
      <div className="site-story-rail" aria-hidden="true"><div className="site-story-icon"><Icon /></div></div>
      <div className="site-story-copy">
        <h2 id={`story-${id}`}>{t(`story.${id}.title`)}</h2>
        <p>{t(`story.${id}.body`)}</p>
        {id === "source" ? <a className="site-story-link" href={REPOSITORY_URL}><GitHubMark />{t("story.source.link")}<ArrowUpRightIcon /></a> : null}
      </div>
      <figure className="site-story-visual"><Scene /></figure>
    </section>)}
  </div>;
}
