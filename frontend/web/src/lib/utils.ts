// The class-name joiner shadcn-registry components import as `cn` (the lucide-animated icons).
// The registry's usual version merges Tailwind classes via clsx + tailwind-merge; this app has no
// Tailwind, so joining the truthy names is all it needs.
export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
