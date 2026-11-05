import { useAttachment } from "./use-attachment.js";
import { ImageViewer } from "./ImageViewer.js";
import { t } from "./i18n.js";
import type { HubConnection } from "./connection.js";
import type { GalleryImage } from "./image-gallery.js";

/** One selected authenticated original, scoped by the owning message. */
export function ImagePreview({ connection, original, images, selected, select, close, saving, feedback, save }: {
  connection: HubConnection; original: { id: string; url?: string; blob?: Blob; error?: string; retry: () => void }; images: readonly GalleryImage[]; selected: string;
  select: (id: string) => void; close: () => void; saving: boolean;
  feedback?: { id: string; text: string; error?: boolean };
  save: (action: "save" | "share", image: GalleryImage, blob: Blob) => void;
}) {
  const index = Math.max(0, images.findIndex(image => image.id === selected)), current = images[index];
  const downloaded = useAttachment(connection, current?.id ?? "", !!current && current.id !== original.id, true);
  if (!current) return null;
  const source = current.id === original.id ? original : downloaded;
  return <ImageViewer imageKey={current.id} name={current.title || t("图片")} {...source}
    index={index} count={images.length} change={offset => { const next = images[index + offset]; if (next) select(next.id); }}
    close={close} saving={saving} save={action => { if (source.blob) save(action, current, source.blob); }}
    feedbackKey={feedback?.id === current.id ? feedback.text : undefined}
    feedback={feedback?.id === current.id && <span role={feedback.error ? "alert" : "status"}>{feedback.text}</span>}/>;
}
