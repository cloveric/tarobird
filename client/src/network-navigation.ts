/** A settings page may stay mounted behind the network manager. Actions that
 * leave that page (pairing another host or opening the connection registry)
 * must pass through its unsaved-draft guard before navigating. */
export type NetworkNavigationGuard = (navigate: () => void) => void;
export type OpenNetwork = (beforeLeave?: NetworkNavigationGuard, initialHostKey?: string, options?: { details?: boolean }) => void;
