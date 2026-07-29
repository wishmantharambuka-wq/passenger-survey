"use client";

import { supabase } from "./client";

/**
 * Field surveys don't sign up — surveyors are handed a URL and a PIN and go.
 * We use Supabase's anonymous auth so every device has a stable identity for
 * RLS (each tap is attributable to a user_id) without a login step. A display
 * name is optional and can be added later.
 */
export async function ensureAnonUser(displayName?: string) {
  const { data: existing } = await supabase.auth.getUser();
  if (!existing.user) {
    const { error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
  }
  if (displayName) {
    const { data: me } = await supabase.auth.getUser();
    if (me.user) {
      await supabase.from("profiles").upsert({
        id: me.user.id, display_name: displayName,
      });
    }
  }
  const { data } = await supabase.auth.getUser();
  return data.user!;
}
