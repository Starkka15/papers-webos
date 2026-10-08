# Papers

An open-source document viewer for the HP TouchPad (webOS), written in Enyo 1,
meant to take the place of the office app the TouchPad shipped with.

It reads documents itself, in JavaScript, following the way LibreOffice imports
each format. Today it shows Word documents (.docx and the older .doc) and plain text; spreadsheets,
and presentations are next. See [TODO.md](TODO.md).

## Layout

| Folder | What it is |
|---|---|
| `app/` | The Enyo 1 app. `source/Docx.js` and `source/Doc.js` are the Word document readers. |
| `service/` | A node service that finds documents on the TouchPad and unpacks them (office files are zip archives) |
| `service/bin/ppzip` | The built zip helper the service runs (the TouchPad's own unzip cannot read many current office files) |
| `native/` | Source of `ppzip`: `ppzip.c` and the [miniz](https://github.com/richgel999/miniz) library (MIT) |
| `package/` | Package description that ties the two together |
| `tools/` | Build, install and test scripts for a TouchPad on USB |

## Building

With the webOS SDK's `palm-package` on the path:

```
palm-package app service package
palm-install com.stark.papers_*_all.ipk
```

`tools/deploy.ps1` does this and relaunches the app on a connected TouchPad; set
the two paths at its top for your machine.

### The zip helper

`service/bin/ppzip` is checked in, so the app can be packaged without a
compiler. To rebuild it you need the webOS PDK and its ARM toolchain
(CodeSourcery arm-2011.03) at `$PDK/arm-toolchain`:

```
make -C native            # PDK defaults to /opt/PalmPDK
cp native/ppzip service/bin/ppzip
```

Build on a native Linux filesystem; the 2011 toolchain cannot read sources from
a Windows or network drive.

## Credits

Papers stands on [LibreOffice](https://www.libreoffice.org/), the free office suite
of The Document Foundation and its contributors. LibreOffice is the model for how
each format is read here, and the source of code translated into this app.

- A file translated from LibreOffice says so at its top, names the LibreOffice file
  it came from, and stays under LibreOffice's license, the Mozilla Public License 2.0
  (some of that code in turn came from Apache OpenOffice, under the Apache License
  2.0, as LibreOffice's own file headers record).
- Translated so far: the preset shapes of the drawing layer. `app/source/ShapeTable.js`
  is generated from LibreOffice's `svx/source/customshapes/EnhancedCustomShapeGeometry.cxx`
  by `tools/gen-shapes.js`, and `app/source/Shapes.js` is a translation of the shape
  evaluator in `svx/source/customshapes/EnhancedCustomShape2d.cxx`. For the newer
  formats, `app/source/PresetTable.js` is generated from
  `oox/source/drawingml/customshapes/presetShapeDefinitions.xml` by `tools/gen-presets.js`,
  and `app/source/Drawing.js` follows `oox/source/drawingml/customshapegeometry.cxx`.
- The readers written for this app (`Doc.js`, `Docx.js`, `Wmf.js`) follow the
  structure of LibreOffice's Word and metafile import code and were checked against
  LibreOffice's rendering of the same files.

Also used: [miniz](https://github.com/richgel999/miniz) (MIT) in the zip helper.

## License

GPL-3.0 for the app as a whole. See [LICENSE](LICENSE). Files translated from
LibreOffice are under the Mozilla Public License 2.0, which allows them to be
combined with it; miniz is under the MIT license
([native/LICENSE.miniz](native/LICENSE.miniz)).
