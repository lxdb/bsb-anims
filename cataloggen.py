from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import re
import struct
import tempfile
from pathlib import Path

from PIL import Image, ImageSequence


HEADER = struct.Struct("<8sBBBBBHBIIIII")
SECTION = struct.Struct("<IIIB")
FRAME = struct.Struct("<BBH")
SCREEN_LEFT = 24
SCREEN_TOP = 61
CELL_SIZE = 10
PREVIEW_SIZE = (768, 248)
MAX_PREVIEW_BYTES = 1024 * 1024
DEVICE_FRAME_SHA256 = "7534fce2f998dd884890a92b1bd31b504884988d13612e06b95219c686788efb"
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
CATALOG_KEYS = {"schema_version", "application_name", "animations"}
ANIMATION_KEYS = {
    "id",
    "name",
    "description",
    "catalog_order",
    "theme_order",
    "width",
    "height",
    "fps",
    "files",
}
FILE_KEYS = {"path", "bytes", "sha256"}
FILE_KINDS = {
    "animation": "animation.anim",
    "theme": "theme.json",
    "framebuffer_preview": "framebuffer.gif",
    "device_preview": "preview.gif",
}


class DriftError(RuntimeError):
    pass


def _decode_rle(payload: bytes, block_size: int, expected_size: int) -> bytes:
    output = bytearray()
    offset = 0
    while offset < len(payload):
        opcode = payload[offset]
        offset += 1
        count = opcode & 0x7F
        if count == 0:
            raise ValueError("RLE frame contains a zero-length run")
        if opcode & 0x80:
            byte_count = count * block_size
            if offset + byte_count > len(payload):
                raise ValueError("RLE frame contains a truncated literal run")
            output.extend(payload[offset : offset + byte_count])
            offset += byte_count
        else:
            if offset + block_size > len(payload):
                raise ValueError("RLE frame contains a truncated repeated run")
            output.extend(payload[offset : offset + block_size] * count)
            offset += block_size
        if len(output) > expected_size:
            raise ValueError("RLE frame expands past the framebuffer size")
    if len(output) != expected_size:
        raise ValueError("RLE frame does not fill the framebuffer")
    return bytes(output)


def validate_animation(path: Path) -> None:
    data = path.read_bytes()
    if len(data) < HEADER.size:
        raise ValueError(f"{path}: animation header is truncated")
    (
        signature,
        flags,
        width,
        height,
        color_mode,
        fps,
        maximum_frame_size,
        unused,
        sections_size,
        frames_size,
        section_count,
        file_frame_count,
        display_frame_count,
    ) = HEADER.unpack_from(data)
    if signature != b"bicycle0" or flags != 0 or unused != 0:
        raise ValueError(f"{path}: invalid animation signature")
    if (width, height, color_mode, fps) != (72, 16, 0, 60):
        raise ValueError(f"{path}: expected 72x16 RGB888 at 60 FPS")
    if len(data) != HEADER.size + sections_size + frames_size:
        raise ValueError(f"{path}: animation chunk lengths do not match the file")
    if section_count <= 0 or file_frame_count <= 0 or display_frame_count <= 0:
        raise ValueError(f"{path}: animation counts must be positive")
    sections_end = HEADER.size + sections_size
    offset = HEADER.size
    sections: list[tuple[str, int, int, int, int]] = []
    for _ in range(section_count):
        if offset + SECTION.size > sections_end:
            raise ValueError(f"{path}: section table is truncated")
        start, end, frame_offset, duration_override = SECTION.unpack_from(data, offset)
        offset += SECTION.size
        name_end = data.find(b"\0", offset, sections_end)
        if name_end < 0:
            raise ValueError(f"{path}: section name is not terminated")
        try:
            name = data[offset:name_end].decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError(f"{path}: section name is not UTF-8") from error
        if not name or start > end or end >= display_frame_count:
            raise ValueError(f"{path}: section frame range is invalid")
        sections.append((name, start, end, frame_offset, duration_override))
        offset = name_end + 1
    if offset != sections_end:
        raise ValueError(f"{path}: section table size is invalid")
    section_names = [section[0] for section in sections]
    if section_names[0] != "default" or len(section_names) != len(set(section_names)):
        raise ValueError(f"{path}: section names are invalid or duplicate")

    offset = sections_end
    duration_sum = 0
    observed_maximum = 0
    frame_boundaries: dict[int, tuple[int, int]] = {}
    framebuffer_size = 72 * 16 * 3
    for _ in range(file_frame_count):
        if offset + FRAME.size > len(data):
            raise ValueError(f"{path}: frame table is truncated")
        frame_offset = offset
        encoding, duration, payload_size = FRAME.unpack_from(data, offset)
        offset += FRAME.size
        if encoding not in (0, 1) or duration <= 0 or payload_size > maximum_frame_size:
            raise ValueError(f"{path}: frame metadata is invalid")
        if offset + payload_size > len(data):
            raise ValueError(f"{path}: frame payload is truncated")
        payload = data[offset : offset + payload_size]
        if encoding == 0:
            if len(payload) != framebuffer_size:
                raise ValueError(f"{path}: raw frame does not fill the framebuffer")
        else:
            try:
                _decode_rle(payload, 3, framebuffer_size)
            except ValueError as error:
                raise ValueError(f"{path}: {error}") from error
        offset += payload_size
        frame_boundaries[frame_offset] = (duration_sum, duration)
        duration_sum += duration
        observed_maximum = max(observed_maximum, payload_size)
    if offset != len(data) or duration_sum != display_frame_count:
        raise ValueError(f"{path}: frame table size or duration is invalid")
    if observed_maximum != maximum_frame_size:
        raise ValueError(f"{path}: maximum frame size does not match the frame table")
    for name, start, _, frame_offset, duration_override in sections:
        boundary = frame_boundaries.get(frame_offset)
        if boundary is None:
            raise ValueError(f"{path}: section {name!r} does not point to a frame")
        frame_start, frame_duration = boundary
        if not 1 <= duration_override <= frame_duration:
            raise ValueError(f"{path}: section {name!r} duration override is invalid")
        if frame_start + frame_duration - duration_override != start:
            raise ValueError(f"{path}: section {name!r} start is inconsistent")


def _skip_gif_sub_blocks(data: bytes, offset: int) -> int:
    while True:
        if offset >= len(data):
            raise ValueError("GIF contains a truncated data block")
        size = data[offset]
        offset += 1
        if size == 0:
            return offset
        if offset + size > len(data):
            raise ValueError("GIF contains a truncated data block")
        offset += size


def _gif_frame_metadata(data: bytes) -> list[tuple[int, tuple[int, int, int, int], int]]:
    if len(data) < 13 or data[:6] not in (b"GIF87a", b"GIF89a"):
        raise ValueError("framebuffer is not a valid GIF")
    width, height, packed = struct.unpack_from("<HHB", data, 6)
    offset = 13
    if packed & 0x80:
        offset += 3 * (2 ** ((packed & 0x07) + 1))
    if offset > len(data):
        raise ValueError("GIF global color table is truncated")

    frames: list[tuple[int, tuple[int, int, int, int], int]] = []
    disposal = 0
    delay = 0
    while offset < len(data):
        marker = data[offset]
        offset += 1
        if marker == 0x3B:
            break
        if marker == 0x21:
            if offset >= len(data):
                raise ValueError("GIF extension is truncated")
            label = data[offset]
            offset += 1
            if label == 0xF9:
                if offset + 6 > len(data) or data[offset] != 4 or data[offset + 5] != 0:
                    raise ValueError("GIF graphics control extension is invalid")
                control = data[offset + 1]
                disposal = (control >> 2) & 0x07
                delay = struct.unpack_from("<H", data, offset + 2)[0] * 10
                offset += 6
            else:
                offset = _skip_gif_sub_blocks(data, offset)
            continue
        if marker != 0x2C or offset + 9 > len(data):
            raise ValueError("GIF contains an invalid block")
        left, top, frame_width, frame_height, image_packed = struct.unpack_from(
            "<HHHHB", data, offset
        )
        offset += 9
        if frame_width <= 0 or frame_height <= 0:
            raise ValueError("GIF frame has invalid dimensions")
        if left + frame_width > width or top + frame_height > height:
            raise ValueError("GIF frame lies outside the canvas")
        if image_packed & 0x80:
            offset += 3 * (2 ** ((image_packed & 0x07) + 1))
        if offset >= len(data):
            raise ValueError("GIF image data is truncated")
        offset += 1
        offset = _skip_gif_sub_blocks(data, offset)
        frames.append((disposal, (left, top, frame_width, frame_height), delay))
        disposal = 0
        delay = 0
    if not frames:
        raise ValueError("framebuffer GIF contains no frames")
    return frames


def _validate_framebuffer(path: Path) -> list[int]:
    metadata = _gif_frame_metadata(path.read_bytes())
    durations = []
    for disposal, bounds, duration in metadata:
        if disposal == 2 and bounds != (0, 0, 72, 16):
            raise ValueError("framebuffer GIF uses partial background disposal")
        if disposal not in (0, 1, 2):
            raise ValueError("framebuffer GIF uses unsupported previous-frame disposal")
        if duration <= 0:
            raise ValueError("framebuffer GIF contains a non-positive delay")
        durations.append(duration)
    return durations


def _led_mask(x: int, y: int) -> tuple[float, float]:
    u = (x + 0.5) / CELL_SIZE
    v = (y + 0.5) / CELL_SIZE
    half_size = 0.85 * 0.5
    radius = math.sqrt(0.5) * half_size
    qx = abs(u - 0.5) - (half_size - radius)
    qy = abs(v - 0.5) - (half_size - radius)
    distance = math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - radius
    delta = 16 / 160 * 1.5

    def smoothstep(edge0: float, edge1: float, value: float) -> float:
        value = min(1.0, max(0.0, (value - edge0) / (edge1 - edge0)))
        return value * value * (3 - 2 * value)

    alpha = 1 - smoothstep(-delta, delta, distance)
    vignette = smoothstep(0.7, 0.3, math.hypot(u - 0.5, v - 0.5))
    return (0.0 if alpha < 0.001 else alpha, 1 - 0.15 * (1 - vignette))


LED_MASK = tuple(_led_mask(x, y) for y in range(CELL_SIZE) for x in range(CELL_SIZE))


def _preview_palette_image() -> Image.Image:
    # Keep the palette below 128 entries so long animations remain under the
    # 1 MiB release limit without dropping source frames or changing timing.
    levels = (0, 64, 128, 192, 255)
    colors = [(0, 0, 0)] + [
        (red, green, blue)
        for red in levels
        for green in levels
        for blue in levels
    ]
    palette = Image.new("P", (1, 1))
    palette.putpalette([component for color in colors for component in color])
    return palette


PREVIEW_PALETTE = _preview_palette_image()


def _paletted_frame(source: Image.Image) -> Image.Image:
    rgba = source.convert("RGBA")
    result = rgba.convert("RGB").quantize(
        palette=PREVIEW_PALETTE,
        dither=Image.Dither.NONE,
    )
    alpha = rgba.getchannel("A")
    result_data = bytearray(result.tobytes())
    alpha_data = alpha.tobytes()
    for index, value in enumerate(result_data):
        if alpha_data[index] == 0:
            result_data[index] = 0
        elif value == 0:
            result_data[index] = 1
    result.frombytes(bytes(result_data))
    result.info["transparency"] = 0
    return result


def _render_frame(frame: Image.Image, device: Image.Image) -> Image.Image:
    source = frame.convert("RGBA")
    if source.size != (72, 16):
        raise ValueError("framebuffer GIF must be 72x16")
    result = device.copy()
    pixels = result.load()
    source_pixels = source.load()
    for source_y in range(16):
        for source_x in range(72):
            red, green, blue, source_alpha = source_pixels[source_x, source_y]
            if source_alpha == 0 or (red + green + blue) / (3 * 255) < 0.04:
                continue
            for cell_y in range(CELL_SIZE):
                for cell_x in range(CELL_SIZE):
                    alpha, brightness = LED_MASK[cell_y * CELL_SIZE + cell_x]
                    if not alpha:
                        continue
                    target_x = SCREEN_LEFT + source_x * CELL_SIZE + cell_x
                    target_y = SCREEN_TOP + source_y * CELL_SIZE + cell_y
                    dst_red, dst_green, dst_blue, dst_alpha = pixels[target_x, target_y]
                    foreground_alpha = alpha * source_alpha / 255
                    pixels[target_x, target_y] = (
                        round(
                            red * brightness * foreground_alpha
                            + dst_red * (1 - foreground_alpha)
                        ),
                        round(
                            green * brightness * foreground_alpha
                            + dst_green * (1 - foreground_alpha)
                        ),
                        round(
                            blue * brightness * foreground_alpha
                            + dst_blue * (1 - foreground_alpha)
                        ),
                        round(255 * foreground_alpha + dst_alpha * (1 - foreground_alpha)),
                    )
    return result


def _render_preview(framebuffer: Path, device_frame: Path) -> bytes:
    expected_durations = _validate_framebuffer(framebuffer)
    with Image.open(device_frame) as opened_device:
        device = opened_device.convert("RGBA")
    if device.size != PREVIEW_SIZE:
        raise ValueError("BUSY Bar device frame must be 768x248")
    rendered: list[Image.Image] = []
    durations: list[int] = []
    has_visible_pixel = False
    with Image.open(framebuffer) as animation:
        if animation.size != (72, 16) or animation.info.get("loop") != 0:
            raise ValueError("framebuffer GIF must be 72x16 and loop forever")
        for frame in ImageSequence.Iterator(animation):
            duration = frame.info.get("duration", animation.info.get("duration", 0))
            if not isinstance(duration, int) or duration <= 0:
                raise ValueError("framebuffer GIF contains a non-positive delay")
            rgba = frame.convert("RGBA")
            has_visible_pixel = has_visible_pixel or rgba.getchannel("A").getbbox() is not None
            rendered.append(_render_frame(rgba, device))
            durations.append(duration)
    if not rendered:
        raise ValueError("framebuffer GIF contains no frames")
    if not has_visible_pixel:
        raise ValueError("framebuffer GIF is entirely transparent")
    if durations != expected_durations:
        raise ValueError("framebuffer GIF timing metadata is inconsistent")
    output = io.BytesIO()
    paletted = [_paletted_frame(frame) for frame in rendered]
    paletted[0].save(
        output,
        format="GIF",
        save_all=True,
        append_images=paletted[1:],
        duration=durations,
        loop=0,
        disposal=1,
        transparency=0,
        palette=PREVIEW_PALETTE.getpalette(),
        optimize=True,
    )
    result = output.getvalue()
    if len(result) > MAX_PREVIEW_BYTES:
        raise ValueError("device preview exceeds 1 MiB")
    generated = _gif_frame_metadata(result)
    if any(disposal != 1 for disposal, _, _ in generated):
        raise ValueError("generated device preview does not use DisposalNone")
    if sum(duration for _, _, duration in generated) != sum(expected_durations):
        raise ValueError("generated device preview does not preserve source timing")
    return result


def _record(data: bytes, relative: str) -> dict[str, object]:
    return {
        "path": relative,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def _readme_catalog(animations: list[dict[str, object]]) -> str:
    sections = []
    for animation in sorted(animations, key=lambda item: item["catalog_order"]):
        files = animation["files"]
        sections.append(
            f"## {animation['name']}\n\n"
            f"![{animation['name']}]({files['device_preview']['path']})\n\n"
            f"{animation['description']}\n\n"
            f"72x16, 60 FPS - [Download .anim]({files['animation']['path']})\n"
        )
    return "\n".join(sections).rstrip() + "\n"


def _repository_path(repository: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative:
        raise ValueError("catalog file path must be a non-empty string")
    path = (repository / relative).resolve()
    try:
        path.relative_to(repository.resolve())
    except ValueError as error:
        raise ValueError(f"catalog path {relative!r} escapes the repository") from error
    return path


def _validate_catalog(repository: Path, catalog: object) -> dict[str, object]:
    if not isinstance(catalog, dict) or set(catalog) != CATALOG_KEYS:
        raise ValueError("catalog must contain schema_version, application_name, and animations")
    if catalog["schema_version"] != 1:
        raise ValueError("catalog schema_version must be 1")
    application_name = catalog["application_name"]
    if not isinstance(application_name, str) or not ID_PATTERN.fullmatch(application_name):
        raise ValueError("catalog application_name is invalid")
    animations = catalog["animations"]
    if not isinstance(animations, list) or not animations:
        raise ValueError("catalog animations must be a non-empty array")
    ids: set[str] = set()
    catalog_orders: set[int] = set()
    theme_orders: set[int] = set()
    for animation in animations:
        if not isinstance(animation, dict) or set(animation) != ANIMATION_KEYS:
            raise ValueError("catalog animation has invalid fields")
        animation_id = animation["id"]
        if (
            not isinstance(animation_id, str)
            or not ID_PATTERN.fullmatch(animation_id)
            or animation_id == "busy"
        ):
            raise ValueError("catalog animation id is invalid or reserved")
        if animation_id in ids:
            raise ValueError(f"duplicate animation id {animation_id!r}")
        ids.add(animation_id)
        for key in ("name", "description"):
            if not isinstance(animation[key], str) or not animation[key].strip():
                raise ValueError(f"animation {animation_id!r} {key} is invalid")
        for key, seen in (("catalog_order", catalog_orders), ("theme_order", theme_orders)):
            value = animation[key]
            if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value in seen:
                raise ValueError(f"animation {animation_id!r} {key} is invalid or duplicate")
            seen.add(value)
        if (animation["width"], animation["height"], animation["fps"]) != (72, 16, 60):
            raise ValueError(f"animation {animation_id!r} must be 72x16 at 60 FPS")
        files = animation["files"]
        if not isinstance(files, dict) or set(files) != set(FILE_KINDS):
            raise ValueError(f"animation {animation_id!r} files are invalid")
        for kind, filename in FILE_KINDS.items():
            record = files[kind]
            if not isinstance(record, dict) or set(record) != FILE_KEYS:
                raise ValueError(f"animation {animation_id!r} {kind} record is invalid")
            relative = record["path"]
            _repository_path(repository, relative)
            expected = f"animations/{animation_id}/{filename}"
            if relative != expected:
                raise ValueError(f"animation {animation_id!r} {kind} path must be {expected}")
            if (
                not isinstance(record["bytes"], int)
                or isinstance(record["bytes"], bool)
                or record["bytes"] < 0
            ):
                raise ValueError(f"animation {animation_id!r} {kind} size is invalid")
            digest = record["sha256"]
            if not isinstance(digest, str) or digest and not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError(f"animation {animation_id!r} {kind} SHA-256 is invalid")
    return catalog


def _build_outputs(repository: Path, device_frame: Path) -> dict[Path, bytes]:
    catalog_path = repository / "catalog.json"
    catalog = _validate_catalog(
        repository, json.loads(catalog_path.read_text(encoding="utf-8"))
    )
    application_name = catalog["application_name"]
    outputs: dict[Path, bytes] = {}
    for animation in catalog["animations"]:
        animation_id = animation["id"]
        files = animation["files"]
        animation_path = _repository_path(repository, files["animation"]["path"])
        framebuffer_path = _repository_path(repository, files["framebuffer_preview"]["path"])
        theme_path = _repository_path(repository, files["theme"]["path"])
        preview_path = _repository_path(repository, files["device_preview"]["path"])
        validate_animation(animation_path)
        theme = {
            "bg_path": f"/ext/user_assets/{application_name}/animations/{animation_id}.anim",
            "order": animation["theme_order"],
        }
        theme_bytes = (json.dumps(theme, indent=4) + "\n").encode()
        preview_bytes = _render_preview(framebuffer_path, device_frame)
        if len(preview_bytes) > MAX_PREVIEW_BYTES:
            raise ValueError(f"{preview_path}: device preview exceeds 1 MiB")
        animation_bytes = animation_path.read_bytes()
        framebuffer_bytes = framebuffer_path.read_bytes()
        outputs[theme_path] = theme_bytes
        outputs[preview_path] = preview_bytes
        files["animation"] = _record(animation_bytes, files["animation"]["path"])
        files["theme"] = _record(theme_bytes, files["theme"]["path"])
        files["framebuffer_preview"] = _record(
            framebuffer_bytes, files["framebuffer_preview"]["path"]
        )
        files["device_preview"] = _record(preview_bytes, files["device_preview"]["path"])

    outputs[catalog_path] = (json.dumps(catalog, indent=2) + "\n").encode()
    readme_path = repository / "README.md"
    readme = readme_path.read_text(encoding="utf-8")
    start = "<!-- catalog:start -->"
    end = "<!-- catalog:end -->"
    before, remainder = readme.split(start, 1)
    _, after = remainder.split(end, 1)
    generated = _readme_catalog(catalog["animations"])
    outputs[readme_path] = f"{before}{start}\n{generated}{end}{after}".encode()
    return outputs


def generate_repository(repository: Path, device_frame: Path) -> None:
    repository = repository.resolve()
    outputs = _build_outputs(repository, device_frame)
    temporary_paths: dict[Path, Path] = {}
    try:
        for path, data in outputs.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
            temporary_path = Path(temporary)
            temporary_paths[path] = temporary_path
            with os.fdopen(descriptor, "wb") as stream:
                os.fchmod(stream.fileno(), 0o644)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        for path, temporary in temporary_paths.items():
            os.replace(temporary, path)
    finally:
        for temporary in temporary_paths.values():
            temporary.unlink(missing_ok=True)


def check_repository(repository: Path, device_frame: Path) -> None:
    repository = repository.resolve()
    drift = []
    for path, expected in _build_outputs(repository, device_frame).items():
        if not path.is_file() or path.read_bytes() != expected:
            drift.append(path.relative_to(repository).as_posix())
    if drift:
        raise DriftError("generated files are stale: " + ", ".join(sorted(drift)))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate and validate bsb-anims catalog artifacts."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("generate", "check"):
        subparser = commands.add_parser(command)
        subparser.add_argument("--repo", required=True, type=Path)
        subparser.add_argument(
            "--device-frame",
            type=Path,
            default=Path(__file__).parent / "third_party" / "busybar-device.png",
        )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    bundled_device = Path(__file__).parent / "third_party" / "busybar-device.png"
    if args.device_frame.resolve() == bundled_device.resolve():
        digest = hashlib.sha256(args.device_frame.read_bytes()).hexdigest()
        if digest != DEVICE_FRAME_SHA256:
            raise ValueError("bundled BUSY Bar device frame does not match the reviewed asset")
    if args.command == "generate":
        generate_repository(args.repo.resolve(), args.device_frame.resolve())
    else:
        check_repository(args.repo.resolve(), args.device_frame.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
