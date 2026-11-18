import { useSyncExternalStore } from "react";
import { getSession, onSessionChange } from "./api/client";
import type { User } from "./api/types";

// The logged-in user, or null. Components re-render on login, logout, and
// when a failed refresh ends the session.
export function useUser(): User | null {
  const session = useSyncExternalStore(onSessionChange, getSession);
  return session?.user ?? null;
}

// For pages that are only reachable while logged in.
export function useRequiredUser(): User {
  const user = useUser();
  if (!user) throw new Error("useRequiredUser outside a logged-in page");
  return user;
}
