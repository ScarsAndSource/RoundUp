// app/watch/[token]/page.tsx
// The watcher experience — zero install, no account needed.
// Friend opens this from a Telegram/WhatsApp link and sees the live session state.
// Polls every 5 seconds. Goes RED when alarm fires.

import WatcherPageClient from "./WatcherPageClient";

export default function WatchPage({ params }: { params: { token: string } }) {
  return <WatcherPageClient token={params.token} />;
}
