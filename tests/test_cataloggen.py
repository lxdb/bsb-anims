import hashlib
import json
import shutil
import struct
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageSequence

import cataloggen


HEADER = struct.Struct("<8sBBBBBHBIIIII")
SECTION = struct.Struct("<IIIB")
FRAME = struct.Struct("<BBH")


def valid_animation() -> bytes:
    section = SECTION.pack(0, 0, HEADER.size + SECTION.size + len("default") + 1, 1) + b"default\0"
    pixels = bytes(72 * 16 * 3)
    frame = FRAME.pack(0, 1, len(pixels)) + pixels
    header = HEADER.pack(
        b"bicycle0",
        0,
        72,
        16,
        0,
        60,
        len(pixels),
        0,
        len(section),
        len(frame),
        1,
        1,
        1,
    )
    return header + section + frame


def write_framebuffer(path: Path, *, identical_prefix: bool = False) -> None:
    first = Image.new("RGB", (72, 16), (0, 0, 0))
    first.putpixel((0, 0), (255, 0, 0))
    second = Image.new("RGB", (72, 16), (0, 0, 0))
    second.putpixel((1, 0), (0, 255, 0))
    frames = [first.copy(), second] if identical_prefix else [second]
    durations = [20, 30, 40] if identical_prefix else [20, 30]
    first.save(
        path,
        save_all=True,
        append_images=frames,
        duration=durations,
        loop=0,
        disposal=2,
    )


class CatalogGeneratorTests(unittest.TestCase):
    def make_repository(self, root: Path, animation_ids=("available",)) -> Path:
        repository = root / "main"
        animations = []
        for index, animation_id in enumerate(animation_ids):
            animation_dir = repository / "animations" / animation_id
            animation_dir.mkdir(parents=True)
            (animation_dir / "animation.anim").write_bytes(valid_animation())
            write_framebuffer(animation_dir / "framebuffer.gif")
            animations.append(
                {
                    "id": animation_id,
                    "name": animation_id.title(),
                    "description": f"{animation_id.title()} description.",
                    "catalog_order": (index + 1) * 10,
                    "theme_order": 150 + index * 10,
                    "width": 72,
                    "height": 16,
                    "fps": 60,
                    "files": {
                        "animation": {
                            "path": f"animations/{animation_id}/animation.anim",
                            "bytes": 0,
                            "sha256": "",
                        },
                        "theme": {
                            "path": f"animations/{animation_id}/theme.json",
                            "bytes": 0,
                            "sha256": "",
                        },
                        "framebuffer_preview": {
                            "path": f"animations/{animation_id}/framebuffer.gif",
                            "bytes": 0,
                            "sha256": "",
                        },
                        "device_preview": {
                            "path": f"animations/{animation_id}/preview.gif",
                            "bytes": 0,
                            "sha256": "",
                        },
                    },
                }
            )
        (repository / "README.md").write_text(
            "# BUSY Bar Animations\n\n<!-- catalog:start -->\nold\n<!-- catalog:end -->\n",
            encoding="utf-8",
        )
        catalog = {
            "schema_version": 1,
            "application_name": "custom_themes",
            "animations": animations,
        }
        (repository / "catalog.json").write_text(json.dumps(catalog), encoding="utf-8")
        return repository

    def write_device(self, root: Path) -> Path:
        path = root / "device.png"
        Image.new("RGBA", (768, 248), (0, 0, 0, 0)).save(path)
        return path

    def test_generate_materializes_catalog_artifacts_from_one_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = root / "main"
            animation_dir = repository / "animations" / "available"
            animation_dir.mkdir(parents=True)
            (animation_dir / "animation.anim").write_bytes(valid_animation())
            write_framebuffer(animation_dir / "framebuffer.gif")
            (repository / "README.md").write_text(
                "# BUSY Bar Animations\n\n<!-- catalog:start -->\nold\n<!-- catalog:end -->\n",
                encoding="utf-8",
            )
            catalog = {
                "schema_version": 1,
                "application_name": "custom_themes",
                "animations": [
                    {
                        "id": "available",
                        "name": "Available",
                        "description": "Let others know you're available.",
                        "catalog_order": 10,
                        "theme_order": 150,
                        "width": 72,
                        "height": 16,
                        "fps": 60,
                        "files": {
                            "animation": {
                                "path": "animations/available/animation.anim",
                                "bytes": 0,
                                "sha256": "",
                            },
                            "theme": {
                                "path": "animations/available/theme.json",
                                "bytes": 0,
                                "sha256": "",
                            },
                            "framebuffer_preview": {
                                "path": "animations/available/framebuffer.gif",
                                "bytes": 0,
                                "sha256": "",
                            },
                            "device_preview": {
                                "path": "animations/available/preview.gif",
                                "bytes": 0,
                                "sha256": "",
                            },
                        },
                    }
                ],
            }
            (repository / "catalog.json").write_text(json.dumps(catalog), encoding="utf-8")
            device = Image.new("RGBA", (768, 248), (0, 0, 0, 0))
            device.save(root / "device.png")

            cataloggen.generate_repository(repository, root / "device.png")

            expected_theme = (
                '{\n'
                '    "bg_path": "/ext/user_assets/custom_themes/animations/available.anim",\n'
                '    "order": 150\n'
                '}\n'
            ).encode()
            self.assertEqual(expected_theme, (animation_dir / "theme.json").read_bytes())
            self.assertEqual(
                0o644, (animation_dir / "theme.json").stat().st_mode & 0o777
            )
            self.assertEqual(
                0o644, (animation_dir / "preview.gif").stat().st_mode & 0o777
            )
            with Image.open(animation_dir / "preview.gif") as preview:
                self.assertEqual((768, 248), preview.size)
                self.assertEqual(2, preview.n_frames)
                self.assertEqual(0, preview.info["loop"])
                self.assertEqual(
                    50,
                    sum(
                        frame.info["duration"]
                        for frame in ImageSequence.Iterator(preview)
                    ),
                )
                for frame in ImageSequence.Iterator(preview):
                    self.assertEqual(1, frame.disposal_method)

            generated = json.loads((repository / "catalog.json").read_text())
            for file_record in generated["animations"][0]["files"].values():
                self.assertGreater(file_record["bytes"], 0)
                self.assertRegex(file_record["sha256"], r"^[0-9a-f]{64}$")

            readme = (repository / "README.md").read_text()
            self.assertIn("![Available](animations/available/preview.gif)", readme)
            self.assertIn("[Download .anim](animations/available/animation.anim)", readme)
            self.assertNotIn("\nold\n", readme)

    def test_preview_coalesces_identical_frames_and_uses_changed_rectangles(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "framebuffer.gif"
            write_framebuffer(source, identical_prefix=True)

            preview = cataloggen._render_preview(source, self.write_device(root))
            path = root / "preview.gif"
            path.write_bytes(preview)

            with Image.open(path) as generated:
                frames = [
                    (frame.info["duration"], frame.tile[0][1], frame.disposal_method)
                    for frame in ImageSequence.Iterator(generated)
                ]
                self.assertEqual(2, len(frames))
                self.assertEqual(90, sum(frame[0] for frame in frames))
                self.assertEqual((0, 0, 768, 248), frames[0][1])
                self.assertNotEqual((0, 0, 768, 248), frames[1][1])
                self.assertTrue(all(frame[2] == 1 for frame in frames))

    def test_rejects_partial_background_disposal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "partial.gif"
            first = Image.new("RGB", (72, 16), "black")
            second = first.copy()
            second.putpixel((0, 0), (255, 0, 0))
            first.save(
                source,
                save_all=True,
                append_images=[second],
                duration=20,
                loop=0,
                disposal=1,
                optimize=True,
            )
            data = bytearray(source.read_bytes())
            first_gce = data.find(b"\x21\xf9\x04")
            second_gce = data.find(b"\x21\xf9\x04", first_gce + 1)
            second_descriptor = data.find(b"\x2c", second_gce)
            self.assertGreaterEqual(second_descriptor, 0)
            self.assertNotEqual(
                bytes((72, 0, 16, 0)),
                data[second_descriptor + 5 : second_descriptor + 9],
            )
            data[second_gce + 3] = (data[second_gce + 3] & 0xE3) | (2 << 2)
            source.write_bytes(data)

            with self.assertRaisesRegex(ValueError, "partial background disposal"):
                cataloggen._render_preview(source, self.write_device(root))

    def test_rejects_fully_transparent_framebuffer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "transparent.gif"
            Image.new("RGBA", (72, 16), (0, 0, 0, 0)).save(
                source, save_all=True, duration=20, loop=0
            )

            with self.assertRaisesRegex(ValueError, "entirely transparent"):
                cataloggen._render_preview(source, self.write_device(root))

    def test_rejects_preview_larger_than_one_mebibyte(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = self.make_repository(root)
            device = self.write_device(root)
            original = cataloggen._render_preview
            cataloggen._render_preview = lambda *_: b"x" * (1024 * 1024 + 1)
            self.addCleanup(setattr, cataloggen, "_render_preview", original)

            with self.assertRaisesRegex(ValueError, "exceeds 1 MiB"):
                cataloggen.generate_repository(repository, device)

    def test_bundled_device_frame_is_the_reviewed_asset(self):
        device = Path(cataloggen.__file__).parent / "third_party" / "busybar-device.png"

        self.assertEqual(
            cataloggen.DEVICE_FRAME_SHA256,
            hashlib.sha256(device.read_bytes()).hexdigest(),
        )

    def test_invalid_later_entry_does_not_replace_earlier_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = self.make_repository(root, ("available", "debug"))
            existing_theme = repository / "animations" / "available" / "theme.json"
            existing_theme.write_bytes(b"keep-existing-theme")
            (repository / "animations" / "debug" / "animation.anim").write_bytes(b"broken")

            with self.assertRaisesRegex(ValueError, "header is truncated"):
                cataloggen.generate_repository(repository, self.write_device(root))

            self.assertEqual(b"keep-existing-theme", existing_theme.read_bytes())
            self.assertFalse((repository / "animations" / "available" / "preview.gif").exists())

    def test_check_reports_drift_without_rewriting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = self.make_repository(root)
            device = self.write_device(root)
            cataloggen.generate_repository(repository, device)
            theme = repository / "animations" / "available" / "theme.json"
            theme.write_bytes(b"drift")

            with self.assertRaisesRegex(cataloggen.DriftError, "theme.json"):
                cataloggen.check_repository(repository, device)

            self.assertEqual(b"drift", theme.read_bytes())

    def test_rejects_animation_with_trailing_or_missing_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.anim"
            path.write_bytes(valid_animation()[:-1])

            with self.assertRaisesRegex(ValueError, "chunk lengths"):
                cataloggen.validate_animation(path)

    def test_rejects_animation_section_that_does_not_point_to_frame_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.anim"
            data = bytearray(valid_animation())
            section_offset = cataloggen.HEADER.size
            start, end, frame_offset, duration = cataloggen.SECTION.unpack_from(
                data, section_offset
            )
            cataloggen.SECTION.pack_into(
                data, section_offset, start, end, frame_offset + 1, duration
            )
            path.write_bytes(data)

            with self.assertRaisesRegex(ValueError, "does not point to a frame"):
                cataloggen.validate_animation(path)

    def test_rejects_duplicate_ids_before_generating_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = self.make_repository(root, ("available", "debug"))
            catalog_path = repository / "catalog.json"
            catalog = json.loads(catalog_path.read_text())
            catalog["animations"][1]["id"] = "available"
            catalog_path.write_text(json.dumps(catalog))

            with self.assertRaisesRegex(ValueError, "duplicate animation id"):
                cataloggen.generate_repository(repository, self.write_device(root))

    def test_rejects_file_path_that_escapes_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = self.make_repository(root)
            outside = root / "outside.anim"
            shutil.copyfile(repository / "animations" / "available" / "animation.anim", outside)
            catalog_path = repository / "catalog.json"
            catalog = json.loads(catalog_path.read_text())
            catalog["animations"][0]["files"]["animation"]["path"] = "../outside.anim"
            catalog_path.write_text(json.dumps(catalog))

            with self.assertRaisesRegex(ValueError, "escapes the repository"):
                cataloggen.generate_repository(repository, self.write_device(root))

    def test_main_check_returns_success_for_current_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = self.make_repository(root)
            device = self.write_device(root)
            cataloggen.generate_repository(repository, device)

            self.assertEqual(
                0,
                cataloggen.main(
                    ["check", "--repo", str(repository), "--device-frame", str(device)]
                ),
            )


if __name__ == "__main__":
    unittest.main()
