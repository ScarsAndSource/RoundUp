"use client";
import { SupabaseProvider } from "@/components/providers/SupabaseProvider";
import RoundupApp from "@/components/RoundupApp";

export default function Page() {
  return (
    <SupabaseProvider>
      <RoundupApp />
    </SupabaseProvider>
  );
}