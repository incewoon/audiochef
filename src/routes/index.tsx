// src/routes/index.tsx

import { createFileRoute } from "@tanstack/react-router";
import { ConverterForm } from "@/components/ConverterForm";
import { AppShell } from "@/components/AppShell";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AudioChef — MP4 to MP3 Converter" },
      { name: "description", content: "Convert MP4 to MP3 with ID3 tag injection right in your browser. Offline-ready PWA." },
      { property: "og:title", content: "AudioChef — MP4 to MP3 Converter" },
      { property: "og:description", content: "Convert MP4 to MP3 with ID3 tag injection right in your browser. Offline-ready PWA." },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <AppShell>
      <ConverterForm />
      <Toaster position="top-center" richColors />
    </AppShell>
  );
}
