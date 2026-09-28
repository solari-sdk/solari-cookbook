// Adapted from pingdotgg/t3code packages/client-runtime/src/providerSkills.ts at 57a66608 (MIT).
// Differs from upstream: the skill type is the plain ProviderSkill {name, displayName?}; only formatProviderSkillDisplayName is kept.
import type { ProviderSkill } from "../components/chat/adapt";

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

export function formatProviderSkillDisplayName(skill: ProviderSkill): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}
