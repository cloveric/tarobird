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
export const SCREEN_QUALITIES = ["smooth", "balanced", "qhd", "sharp"] as const;
export type ScreenQuality = typeof SCREEN_QUALITIES[number];
export const SCREEN_DEFAULT_QUALITY: ScreenQuality = "balanced";
/** H.264 frame-size limits in 16×16 macroblocks: level 4.0 and level 5.1. */
export const SCREEN_H264_L40_MACROBLOCKS = 8192, SCREEN_H264_L51_MACROBLOCKS = 36864;
export type ScreenQualityProfile = {
  /** Encoded long-edge, area and macroblock caps; never upscaled. */
  longEdge: number; area: number; macroblocks: number;
  /** The most frames a second this profile captures and encodes. It is a
   * ceiling, not a target: the source delivers its display's own rate (60 on
   * most screens, 120 on some), `smooth` and `balanced` take up to 120 and
   * `sharp`, with several times the pixels, up to 60. The target steps down
   * (`screenRateLadder`) when its encoder cannot take a rate at the encoded
   * size; a slower viewer or a busy picture lowers the real rate through the
   * credit window and the byte budget. */
  fps: number;
  /** Per-frame quantizer at rest, and the ceiling congestion may raise it to. */
  qpBase: number; qpMax: number;
  /** Target bitrate when the encoder only offers variable-bitrate mode. */
  bitrate: number;
  /** Only H.264 can carry this size; VP8 is never substituted for it. */
  h264Only: boolean;
};
export const SCREEN_QUALITY_PROFILES: Readonly<Record<ScreenQuality, Readonly<ScreenQualityProfile>>> = Object.freeze({
  smooth: Object.freeze({ longEdge: 1280, area: 1280 * 800, macroblocks: SCREEN_H264_L40_MACROBLOCKS, fps: 120, qpBase: 32, qpMax: 42, bitrate: 1_200_000, h264Only: false }),
  balanced: Object.freeze({ longEdge: 1920, area: 1920 * 1080, macroblocks: SCREEN_H264_L40_MACROBLOCKS, fps: 120, qpBase: 28, qpMax: 40, bitrate: 2_500_000, h264Only: false }),
  qhd: Object.freeze({ longEdge: 2560, area: 2560 * 1440, macroblocks: SCREEN_H264_L51_MACROBLOCKS, fps: 60, qpBase: 28, qpMax: 40, bitrate: 3_000_000, h264Only: true }),
  sharp: Object.freeze({ longEdge: 3072, area: 3072 * 1920, macroblocks: SCREEN_H264_L51_MACROBLOCKS, fps: 60, qpBase: 28, qpMax: 40, bitrate: 3_200_000, h264Only: true }),
});
/** Largest stream any profile may produce (the shared stream schema bound). */
export const SCREEN_STREAM_MAX_EDGE = 3072, SCREEN_STREAM_MAX_AREA = 3072 * 1920;
/** Frames a target keeps unacknowledged at once. Three always; more only for a
 * viewer that said how many it can hold (`flight` on open), and then only the
 * frames really in transit on its path (see the capture core), never above
 * the maximum. */
export const SCREEN_FLIGHT_MIN = 3, SCREEN_FLIGHT_MAX = 16;
/** The longest a viewer may say it held a frame (`heldMs`): frames are only fresh for this long. */
export const SCREEN_HELD_MAX_MS = 2000;
/** The rate every stream ran at before profiles named their own. */
export const SCREEN_LEGACY_FPS = 15;
/** The rates a target tries for a profile, highest first: its ceiling, then each lower standard rate. */
export function screenRateLadder(fps: number): number[] {
  return [fps, 60, 30, SCREEN_LEGACY_FPS].filter((rate, index, all) => rate <= fps && all.indexOf(rate) === index);
}
/** H.264 High profile codec string a stream DECLARES for an encoded size:
 * level 4.0 when the size fits (the pre-quality string), otherwise level 5.1;
 * undefined if neither. It depends on the size only and is what every viewer
 * has always been given to open its decoder with, whatever the frame rate.
 * The level the bitstream itself carries is `screenH264EncoderCodec`. */
export function screenH264Codec(width: number, height: number): string | undefined {
  const blocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  return blocks <= SCREEN_H264_L40_MACROBLOCKS ? "avc1.640028" : blocks <= SCREEN_H264_L51_MACROBLOCKS ? "avc1.640033" : undefined;
}
/** H.264 levels as [codec string, largest frame in macroblocks, macroblocks per second]: 4.0, 4.2, 5.1, 5.2. */
const H264_LEVELS: readonly (readonly [string, number, number])[] = [["avc1.640028", 8192, 245_760], ["avc1.64002A", 8704, 522_240], ["avc1.640033", 36_864, 983_040], ["avc1.640034", 36_864, 2_073_600]];
/** H.264 High profile codec string an ENCODER is configured with for a size
 * and rate: the lowest level that carries both (1080p-class is 4.0 up to 30,
 * 4.2 at 60 and 5.1 at 120). Undefined when no level fits. */
export function screenH264EncoderCodec(width: number, height: number, fps: number): string | undefined {
  const blocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  return H264_LEVELS.find(([, frame, rate]) => blocks <= frame && blocks * fps <= rate)?.[0];
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
