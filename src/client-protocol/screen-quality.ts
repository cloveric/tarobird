/** Remote-screen picture quality. Pure and import-free: shared by the Hub,
 * the target service (Electron main) and the viewers.
 *
 * A quality is chosen when a session opens and never changes inside it; a
 * different quality is a new session (new generation, tickets and stream, no
 * carried lease). Every profile changes the real capture constraints, encoder
 * size and quantizer/bitrate — never only presentation.
 *
 * `balanced` is the pre-quality behaviour (and what an open without `quality`
 * gets). `smooth` encodes fewer pixels at a coarser quantizer. `sharp` raises
 * the size cap towards the display's physical resolution (H.264 level 5.1),
 * where text keeps its pixel structure; only a viewer that asked for it, via a
 * Host and target that both advertised quality, can ever receive such a
 * stream. The Hub enforces each session's profile caps. */
export const SCREEN_QUALITIES = ["smooth", "balanced", "sharp"] as const;
export type ScreenQuality = typeof SCREEN_QUALITIES[number];
export const SCREEN_DEFAULT_QUALITY: ScreenQuality = "balanced";
/** H.264 frame-size limits in 16×16 macroblocks: level 4.0 and level 5.1. */
export const SCREEN_H264_L40_MACROBLOCKS = 8192, SCREEN_H264_L51_MACROBLOCKS = 36864;
export type ScreenQualityProfile = {
  /** Encoded long-edge, area and macroblock caps; never upscaled. */
  longEdge: number; area: number; macroblocks: number;
  /** Capture/encode frame-rate cap. */
  fps: number;
  /** Per-frame quantizer at rest, and the ceiling congestion may raise it to. */
  qpBase: number; qpMax: number;
  /** Target bitrate when the encoder only offers variable-bitrate mode. */
  bitrate: number;
  /** Only H.264 can carry this size; VP8 is never substituted for it. */
  h264Only: boolean;
};
export const SCREEN_QUALITY_PROFILES: Readonly<Record<ScreenQuality, Readonly<ScreenQualityProfile>>> = Object.freeze({
  smooth: Object.freeze({ longEdge: 1280, area: 1280 * 800, macroblocks: SCREEN_H264_L40_MACROBLOCKS, fps: 15, qpBase: 32, qpMax: 42, bitrate: 1_200_000, h264Only: false }),
  balanced: Object.freeze({ longEdge: 1920, area: 1920 * 1080, macroblocks: SCREEN_H264_L40_MACROBLOCKS, fps: 15, qpBase: 28, qpMax: 40, bitrate: 2_500_000, h264Only: false }),
  sharp: Object.freeze({ longEdge: 3072, area: 3072 * 1920, macroblocks: SCREEN_H264_L51_MACROBLOCKS, fps: 15, qpBase: 28, qpMax: 40, bitrate: 3_200_000, h264Only: true }),
});
/** Largest stream any profile may produce (the shared stream schema bound). */
export const SCREEN_STREAM_MAX_EDGE = 3072, SCREEN_STREAM_MAX_AREA = 3072 * 1920;
/** H.264 High profile codec string for an encoded size: level 4.0 when it
 * fits (the pre-quality string), otherwise level 5.1; undefined if neither. */
export function screenH264Codec(width: number, height: number): string | undefined {
  const blocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  return blocks <= SCREEN_H264_L40_MACROBLOCKS ? "avc1.640028" : blocks <= SCREEN_H264_L51_MACROBLOCKS ? "avc1.640033" : undefined;
}
export function isScreenQuality(value: unknown): value is ScreenQuality {
  return typeof value === "string" && (SCREEN_QUALITIES as readonly string[]).includes(value);
}
/** The profile for `quality`; an omitted quality is the legacy default. */
export function screenQualityProfile(quality: ScreenQuality | undefined): Readonly<ScreenQualityProfile> {
  if (quality === undefined) return SCREEN_QUALITY_PROFILES[SCREEN_DEFAULT_QUALITY];
  if (!isScreenQuality(quality)) throw new Error("screen_quality_invalid");
  return SCREEN_QUALITY_PROFILES[quality];
}
