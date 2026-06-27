import { ForgejoIcon } from "@/components/icons/forgejo-icon";
import { GiteaIcon } from "@/components/icons/gitea-icon";
import { GitHubIcon } from "@/components/icons/github-icon";
import { GitLabIcon } from "@/components/icons/gitlab-icon";
import { getForgePresentation, type Forge } from "@/git/forge";

export function PullRequestTabIcon({
  forge,
  size,
  color,
}: {
  forge: Forge;
  size: number;
  color: string;
}) {
  const icon = getForgePresentation(forge).icon;
  if (icon === "gitlab") {
    return <GitLabIcon size={size} color={color} />;
  }
  if (icon === "gitea") {
    return <GiteaIcon size={size} color={color} />;
  }
  if (icon === "forgejo") {
    return <ForgejoIcon size={size} color={color} />;
  }
  return <GitHubIcon size={size} color={color} />;
}
