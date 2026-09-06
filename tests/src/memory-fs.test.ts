import { describe, it, expect } from "vitest";
import { MemoryFS } from "../../src/memory-fs";

// GIST-14: MemoryFS is the in-memory filesystem shim isomorphic-git runs
// against inside the Worker (there is no real fs). These exercise the
// surface directly rather than only through a Gist image push.

describe("MemoryFS", () => {
  it("writes a file and reads it back as bytes or as a decoded string", async () => {
    const fs = new MemoryFS();
    await fs.promises.writeFile("/repo/notes.md", "hello world");
    expect(await fs.promises.readFile("/repo/notes.md")).toBeInstanceOf(Uint8Array);
    expect(await fs.promises.readFile("/repo/notes.md", "utf8")).toBe("hello world");
  });

  it("auto-creates parent directories on writeFile", async () => {
    const fs = new MemoryFS();
    await fs.promises.writeFile("/a/b/c/deep.txt", "x");
    expect(await fs.promises.readdir("/a/b/c")).toEqual(["deep.txt"]);
    expect((await fs.promises.stat("/a/b")).isDirectory()).toBe(true);
  });

  it("readdir returns a sorted child list; stat/lstat report kind and size", async () => {
    const fs = new MemoryFS();
    await fs.promises.mkdir("/d", { recursive: true });
    await fs.promises.writeFile("/d/z.txt", "zz");
    await fs.promises.writeFile("/d/a.txt", "a");
    expect(await fs.promises.readdir("/d")).toEqual(["a.txt", "z.txt"]);
    const st = await fs.promises.stat("/d/z.txt");
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe(2);
    expect((await fs.promises.lstat("/d")).isDirectory()).toBe(true);
  });

  it("unlink removes a file and drops it from its directory listing", async () => {
    const fs = new MemoryFS();
    await fs.promises.writeFile("/d/x.txt", "x");
    await fs.promises.unlink("/d/x.txt");
    expect(await fs.promises.readdir("/d")).toEqual([]);
    await expect(fs.promises.readFile("/d/x.txt")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("readFile on a missing path rejects with ENOENT", async () => {
    const fs = new MemoryFS();
    await expect(fs.promises.readFile("/nope")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("mkdir without recursive rejects when the parent is missing", async () => {
    const fs = new MemoryFS();
    await expect(fs.promises.mkdir("/x/y")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("symlink / readlink are bound but always throw (this fs never makes links)", async () => {
    const fs = new MemoryFS();
    expect(typeof fs.promises.symlink).toBe("function");
    await expect(fs.promises.readlink("/whatever")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.promises.symlink("/target", "/link")).rejects.toMatchObject({ code: "ENOSYS" });
  });

  it("normalizes . and .. segments in a path", async () => {
    const fs = new MemoryFS();
    await fs.promises.writeFile("/a/b/file.txt", "1");
    expect(await fs.promises.readFile("/a/./b/../b/file.txt", "utf8")).toBe("1");
  });
});
