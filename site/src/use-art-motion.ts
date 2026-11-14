import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSiteMotion } from "./motion";

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const pageVisible = () => !document.hidden;
const serverVisible = () => true;

/** Decorative loops run only while visible and permitted by page/system settings. */
export function useArtMotion() {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const { status } = useSiteMotion();
  const foreground = useSyncExternalStore(subscribeVisibility, pageVisible, serverVisible);

  useEffect(() => {
    const observer = new IntersectionObserver(entries => setInView(entries.some(entry => entry.isIntersecting)), { threshold: .2 });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return { ref, playing: status === "auto" && inView && foreground };
}
