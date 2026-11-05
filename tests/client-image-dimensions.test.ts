import { describe, expect, test, vi } from "vitest";
import type { HubConnection } from "../client/src/connection.js";
import { imageDimensions, imageReservation, MAX_IMAGE_DIMENSIONS, rememberImageDimensions, subscribeImageDimensions } from "../client/src/image-dimensions.js";

const connection = () => ({}) as HubConnection;
describe("decoded image geometry for virtual history", () => {
  test("retains only dimensions and isolates identical attachment IDs by connection", () => {
    const a = connection(), b = connection();
    rememberImageDimensions(a, "image", { width: 600, height: 800 });
    expect(imageDimensions(a, "image")).toEqual({ width: 600, height: 800 });
    expect(imageDimensions(b, "image")).toBeUndefined();
    rememberImageDimensions(b, "image", { width: 960, height: 540 });
    expect(imageDimensions(a, "image")).toEqual({ width: 600, height: 800 });
    expect(imageDimensions(b, "image")).toEqual({ width: 960, height: 540 });
  });
  test("bounds retained metadata and evicts least recently used dimensions", () => {
    const host = connection();
    for (let i = 0; i < MAX_IMAGE_DIMENSIONS; i++) rememberImageDimensions(host, String(i), { width: 10, height: i + 1 });
    imageDimensions(host, "0");
    rememberImageDimensions(host, "next", { width: 20, height: 30 });
    expect(imageDimensions(host, "0")).toEqual({ width: 10, height: 1 });
    expect(imageDimensions(host, "1")).toBeUndefined();
    expect(imageDimensions(host, "next")).toEqual({ width: 20, height: 30 });
  });
  test("invalid decode sizes cannot replace a useful reservation", () => {
    const host = connection();
    rememberImageDimensions(host, "image", { width: 600, height: 800 });
    for (const value of [0, -1, NaN, Infinity]) rememberImageDimensions(host, "image", { width: value, height: 800 });
    expect(imageDimensions(host, "image")).toEqual({ width: 600, height: 800 });
  });
  test("publishes new geometry to already mounted siblings without repeat or cross-host notifications", () => {
    const a = connection(), b = connection(), same = vi.fn(), otherId = vi.fn(), otherHost = vi.fn();
    const unsubscribe = subscribeImageDimensions(a, "image", same);
    subscribeImageDimensions(a, "other", otherId);
    subscribeImageDimensions(b, "image", otherHost);
    rememberImageDimensions(a, "image", { width: 600, height: 800 });
    rememberImageDimensions(a, "image", { width: 600, height: 800 });
    rememberImageDimensions(a, "image", { width: 0, height: 800 });
    expect(same).toHaveBeenCalledTimes(1);
    expect(otherId).not.toHaveBeenCalled(); expect(otherHost).not.toHaveBeenCalled();
    rememberImageDimensions(a, "image", { width: 960, height: 540 });
    expect(same).toHaveBeenCalledTimes(2);
    unsubscribe();
    rememberImageDimensions(a, "image", { width: 800, height: 600 });
    expect(same).toHaveBeenCalledTimes(2);
  });
  test("the empty reservation encodes exact intrinsic dimensions without original bytes", () => {
    const source = imageReservation({ width: 540, height: 960 });
    expect(decodeURIComponent(source)).toBe('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="540" height="960"/>');
  });
});
