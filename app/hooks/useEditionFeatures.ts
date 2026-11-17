import { useQuery } from "@tanstack/react-query";
import type { PublicEditionFeatures } from "../../shared/wemail/edition";
import api from "~/services/api";

/**
 * Edition feature switches — the single way the renderer learns which
 * internal modules (WeCLI, allowance/invoice, enterprise directory, office
 * scene detection) are built into this edition. Internal entry points hide
 * behind these flags; never behind environment variables.
 *
 * Shares the ["system", "edition"] query with onboarding and useComposeForm,
 * so the edition is fetched once per QueryClient cache. Every flag defaults
 * to false (open edition, or while the edition info is still loading).
 */
export function useEditionFeatures(): PublicEditionFeatures {
  const { data } = useQuery({
    queryKey: ["system", "edition"],
    queryFn: () => api.getEditionInfo(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
  return {
    wecli: data?.features?.wecli ?? false,
    allowanceInvoice: data?.features?.allowanceInvoice ?? false,
    enterpriseDirectory: data?.features?.enterpriseDirectory ?? false,
    officeSceneDetection: data?.features?.officeSceneDetection ?? false,
  };
}
