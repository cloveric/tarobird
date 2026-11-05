import { useEffect, useState } from "react";
import { ImageViewer, type ImageViewerProps } from "./ImageViewer.js";

/** The caller owns the bytes; this lease owns only its preview URL. */
export function LocalImagePreview({ blob, ...props }: Omit<ImageViewerProps, "url" | "imageKey" | "blob"> & { blob: Blob }) {
  const [source, setSource] = useState<{ blob: Blob; url: string }>();
  useEffect(() => {
    const url = URL.createObjectURL(blob); setSource({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  const url = source?.blob === blob ? source.url : undefined;
  return <ImageViewer {...props} imageKey={url ?? props.name} url={url} blob={blob}/>;
}
