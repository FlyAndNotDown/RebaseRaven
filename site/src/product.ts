import { LATEST_RELEASE_URL, REPOSITORY_URL } from "./release-downloads.ts";
import { siteResources, type SiteLocale } from "./i18n.ts";

export const SITE_URL = "https://rebaseraven.flyandnotdown.com/";

export function softwareApplication(locale: SiteLocale = "en", rootPage = true) {
  const copy = siteResources[locale];
  return {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "@id": `${SITE_URL}#application`,
  name: "RebaseRaven",
  url: rootPage ? SITE_URL : `${SITE_URL}${locale}/`,
  description: copy["meta.description"],
  inLanguage: locale,
  applicationCategory: "DeveloperApplication",
  applicationSubCategory: "Git GUI and Perforce desktop client",
  operatingSystem: ["macOS (Apple Silicon)", "Windows (x64)"],
  license: "https://opensource.org/license/mit",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD", url: LATEST_RELEASE_URL },
  softwareRequirements: copy["faq.tools.answer"],
  image: `${SITE_URL}assets/social.png`,
  downloadUrl: LATEST_RELEASE_URL,
  sameAs: REPOSITORY_URL,
  featureList: [
    copy["capabilities.review.git"],
    copy["capabilities.organize.p4"],
    copy["capabilities.history.p4"],
    copy["capabilities.advanced.p4"],
    copy["features.context.body"],
  ],
  } as const;
}

export const SOFTWARE_APPLICATION = softwareApplication();
