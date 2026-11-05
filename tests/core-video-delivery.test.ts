import { describe, expect, it, vi } from "vitest";

import {
  extractVideoCoverJpeg,
  sendCoreVideoWithCover,
  type VideoCoverExecFile,
} from "../src/core/video-delivery.js";
import type { CoreChannelLike } from "../src/core/types.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);

function fakeChannel() {
  const uploadImage = vi.fn(async (_body: Buffer) => "img_cover");
  const send = vi.fn(async () => ({ messageId: "om_video" }));
  return {
    channel: {
      send,
      uploadImage,
    } as unknown as CoreChannelLike,
    uploadImage,
    send,
  };
}

describe("Core video cover delivery", () => {
  it("extracts a frame at one second and attaches its uploaded cover key to the video", async () => {
    const execFileImpl = vi.fn<VideoCoverExecFile>(async () => ({
      stdout: JPEG,
      stderr: Buffer.alloc(0),
    }));
    const { channel, uploadImage, send } = fakeChannel();

    await sendCoreVideoWithCover({
      channel,
      chatId: "oc_chat",
      videoPath: "/tmp/clip.mp4",
      body: Buffer.from("video"),
      fileName: "clip.mp4",
      options: { replyTo: "om_source" },
      execFileImpl,
    });

    expect(execFileImpl).toHaveBeenCalledTimes(1);
    expect(execFileImpl.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["-ss", "1"]));
    expect(uploadImage).toHaveBeenCalledWith(JPEG);
    expect(send).toHaveBeenCalledWith("oc_chat", {
      video: {
        source: Buffer.from("video"),
        fileName: "clip.mp4",
        coverImageKey: "img_cover",
      },
    }, { replyTo: "om_source" });
  });

  it("falls back to frame zero when the one-second frame cannot be extracted", async () => {
    const execFileImpl = vi.fn<VideoCoverExecFile>()
      .mockRejectedValueOnce(new Error("past end of short video"))
      .mockResolvedValueOnce({ stdout: JPEG, stderr: Buffer.alloc(0) });

    const cover = await extractVideoCoverJpeg("/tmp/short.mp4", execFileImpl);

    expect(cover).toEqual(JPEG);
    expect(execFileImpl).toHaveBeenCalledTimes(2);
    expect(execFileImpl.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["-ss", "0"]));
  });

  it("still sends the video when cover extraction fails", async () => {
    const execFileImpl = vi.fn<VideoCoverExecFile>(async () => {
      throw new Error("ffmpeg unavailable");
    });
    const { channel, uploadImage, send } = fakeChannel();

    await sendCoreVideoWithCover({
      channel,
      chatId: "oc_chat",
      videoPath: "/tmp/clip.mp4",
      body: Buffer.from("video"),
      fileName: "clip.mp4",
      execFileImpl,
    });

    expect(execFileImpl).toHaveBeenCalledTimes(2);
    expect(uploadImage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("oc_chat", {
      video: {
        source: Buffer.from("video"),
        fileName: "clip.mp4",
      },
    }, undefined);
  });

  it("still sends the video when the upload port rejects only the cover image", async () => {
    const execFileImpl = vi.fn<VideoCoverExecFile>(async () => ({
      stdout: JPEG,
      stderr: Buffer.alloc(0),
    }));
    const { channel, uploadImage, send } = fakeChannel();
    uploadImage.mockRejectedValueOnce(new Error("cover upload rejected"));

    await sendCoreVideoWithCover({
      channel,
      chatId: "oc_chat",
      videoPath: "/tmp/clip.mp4",
      body: Buffer.from("video"),
      fileName: "clip.mp4",
      execFileImpl,
    });

    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("oc_chat", {
      video: {
        source: Buffer.from("video"),
        fileName: "clip.mp4",
      },
    }, undefined);
  });
});
