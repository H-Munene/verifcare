import type { ForwardRefExoticComponent, HTMLAttributes, RefAttributes } from 'react';

// The shape every lucide-animated icon in components/icons shares, so a component can take "any
// animated icon" and drive its animation through the ref (e.g. on hover of a whole nav row).
export interface AnimatedIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

export type AnimatedIcon = ForwardRefExoticComponent<
  HTMLAttributes<HTMLDivElement> & { size?: number } & RefAttributes<AnimatedIconHandle>
>;
