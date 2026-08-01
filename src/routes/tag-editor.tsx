//src/routes/tag-editor.tsx

import { createFileRoute } from "@tanstack/react-router";
import { TagEditorForm } from "@/components/TagEditorForm";
import { AppShell } from "@/components/AppShell";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/tag-editor")({
  head: () => ({
    meta: [
      { title: "AudioChef — MP3 Tag Editor" },
      { name: "description", content: "Edit MP3 ID3 tags (title, artist, album, genre, lyrics, album art) in your browser." },
      { property: "og:title", content: "AudioChef — MP3 Tag Editor" },
      { property: "og:description", content: "Edit MP3 ID3 tags right in your browser." },
    ],
  }),
  component: TagEditorPage,
});

function TagEditorPage() {
  return (
    <AppShell>
      <TagEditorForm />
      <Toaster position="top-center" richColors />
    </AppShell>
  );
}
