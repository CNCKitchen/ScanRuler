// SPDX-License-Identifier: AGPL-3.0-only
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;

namespace ScanRuler.ProjectPreview
{
    internal static class PreviewImage
    {
        internal const int MaxEncodedBytes = 8 * 1024 * 1024;
        internal const int MaxDimension = 2048;
        internal const string MissingMessage =
            "No saved preview. Open and save this project in a preview-enabled ScanRuler version.";
        private const int MaxMembers = 4096;
        private const int MaxHeaderBytes = 2 * 1024 * 1024;

        internal static Bitmap Read(Stream stream)
        {
            if (!stream.CanSeek || !stream.CanRead)
                throw new InvalidDataException("A readable, seekable project stream is required.");
            long length = stream.Length;
            if (length < 22) throw BadZip();

            // Only the bounded ZIP tail and local headers are read. Scan payloads are
            // skipped with Seek, never inflated or copied into memory.
            int tailLength = (int)Math.Min(length, 65557);
            stream.Position = length - tailLength;
            byte[] tail = Bytes(stream, tailLength);
            int end = -1;
            for (int i = tail.Length - 22; i >= 0; --i)
                if (U32(tail, i) == 0x06054b50 &&
                    i + 22 + U16(tail, i + 20) == tail.Length)
                { end = i; break; }
            if (end < 0) throw BadZip();
            if (U16(tail, end + 4) != 0 || U16(tail, end + 6) != 0)
                throw new InvalidDataException("Multi-disk ZIP projects are not supported.");
            int count = U16(tail, end + 10);
            uint directorySize = U32(tail, end + 12);
            uint directoryOffset = U32(tail, end + 16);
            if (count == 65535 || directorySize == uint.MaxValue || directoryOffset == uint.MaxValue)
                throw new InvalidDataException("ZIP64 projects are not supported.");
            if (count < 1 || count > MaxMembers || U16(tail, end + 8) != count)
                throw new InvalidDataException("Invalid or excessive ZIP member count.");
            long endOffset = length - tailLength + end;
            if ((long)directoryOffset + directorySize != endOffset ||
                directorySize < (long)count * 46) throw BadZip();

            stream.Position = 0;
            int headerBytes = 0;
            for (int index = 0; index < count; ++index)
            {
                if (stream.Position + 30 > directoryOffset) throw BadZip();
                byte[] header = Bytes(stream, 30);
                if (U32(header, 0) != 0x04034b50) throw BadZip();
                int flags = U16(header, 6);
                int method = U16(header, 8);
                if ((flags & (1 | 64 | 8192)) != 0)
                    throw new InvalidDataException("Encrypted ZIP members are not supported.");
                if ((flags & 8) != 0)
                    throw new InvalidDataException("ZIP data descriptors are not supported.");
                if ((flags & ~(2 | 4 | 2048)) != 0)
                    throw new InvalidDataException("Unsupported ZIP flags.");
                if (method != 0 && method != 8)
                    throw new InvalidDataException("Unsupported ZIP compression method.");
                uint size = U32(header, 18);
                uint unpackedSize = U32(header, 22);
                if (size == uint.MaxValue || unpackedSize == uint.MaxValue)
                    throw new InvalidDataException("ZIP64 members are not supported.");
                if (method == 0 && size != unpackedSize) throw BadZip();
                int nameLength = U16(header, 26);
                int extraLength = U16(header, 28);
                headerBytes += 30 + nameLength + extraLength;
                if (nameLength < 1 || nameLength > 4096 || headerBytes > MaxHeaderBytes)
                    throw new InvalidDataException("Excessive ZIP header data.");
                if (stream.Position + nameLength + extraLength + size > directoryOffset)
                    throw BadZip();
                byte[] name = Bytes(stream, nameLength);
                string member = Encoding.UTF8.GetString(name);
                if (index == 0 && member != "project.json")
                    throw new InvalidDataException("The first project member must be project.json.");
                stream.Seek(extraLength, SeekOrigin.Current);
                if (member == "preview.png")
                {
                    if (method != 0)
                        throw new InvalidDataException("preview.png must be stored without ZIP compression.");
                    if (size < 57 || size > MaxEncodedBytes)
                        throw new InvalidDataException("Saved preview exceeds the encoded size limit or is empty.");
                    byte[] png = Bytes(stream, (int)size);
                    if (Crc(png, 0, png.Length) != U32(header, 14))
                        throw new InvalidDataException("Saved preview ZIP checksum is invalid.");
                    return Decode(png);
                }
                stream.Seek(size, SeekOrigin.Current);
            }
            if (stream.Position != directoryOffset) throw BadZip();
            // A missing image is only a legacy result if the directory is coherent.
            ValidateDirectory(stream, count, directorySize, directoryOffset);
            return null;
        }

        private static void ValidateDirectory(Stream stream, int count, uint size, uint offset)
        {
            long expectedLocalOffset = 0;
            for (int i = 0; i < count; ++i)
            {
                if (stream.Position + 46 > (long)offset + size) throw BadZip();
                byte[] header = Bytes(stream, 46);
                if (U32(header, 0) != 0x02014b50 || U16(header, 34) != 0 ||
                    U32(header, 42) != expectedLocalOffset) throw BadZip();
                int nameLength = U16(header, 28);
                if (nameLength < 1 || nameLength > 4096) throw BadZip();
                int remaining = nameLength + U16(header, 30) + U16(header, 32);
                if (stream.Position + remaining > (long)offset + size) throw BadZip();
                byte[] name = Bytes(stream, nameLength);
                long nextDirectoryEntry = stream.Position + remaining - nameLength;
                stream.Position = expectedLocalOffset;
                byte[] local = Bytes(stream, 30);
                if (U16(local, 26) != nameLength || U16(local, 6) != U16(header, 8) ||
                    U16(local, 8) != U16(header, 10) || U32(local, 14) != U32(header, 16) ||
                    U32(local, 18) != U32(header, 20) || U32(local, 22) != U32(header, 24))
                    throw BadZip();
                byte[] localName = Bytes(stream, nameLength);
                for (int n = 0; n < nameLength; ++n)
                    if (name[n] != localName[n]) throw BadZip();
                expectedLocalOffset += 30L + nameLength + U16(local, 28) + U32(local, 18);
                stream.Position = nextDirectoryEntry;
            }
            if (stream.Position != (long)offset + size || expectedLocalOffset != offset) throw BadZip();
        }

        internal static Bitmap Decode(byte[] png)
        {
            if (png.Length > MaxEncodedBytes || png.Length < 57 ||
                U32(png, 0) != 0x474e5089 || U32(png, 4) != 0x0a1a0a0d ||
                Big32(png, 8) != 13 || Encoding.ASCII.GetString(png, 12, 4) != "IHDR")
                throw new InvalidDataException("Saved preview is not a valid PNG.");
            uint width = Big32(png, 16), height = Big32(png, 20);
            if (width < 1 || height < 1 || width > MaxDimension || height > MaxDimension)
                throw new InvalidDataException("Saved preview dimensions exceed 2048 pixels.");
            if (png[26] != 0 || png[27] != 0 || png[28] > 1)
                throw new InvalidDataException("Unsupported PNG encoding.");
            bool data = false, ended = false;
            int chunks = 0;
            using (MemoryStream pixelsOnly = new MemoryStream())
            {
                pixelsOnly.Write(png, 0, 8);
                for (int p = 8; p < png.Length;)
                {
                    if (++chunks > 65536 || p + 12 > png.Length)
                        throw new InvalidDataException("Malformed PNG chunks.");
                    uint chunkLength = Big32(png, p);
                    if (chunkLength > png.Length - p - 12) throw new InvalidDataException("Truncated PNG chunk.");
                    int n = (int)chunkLength;
                    string type = Encoding.ASCII.GetString(png, p + 4, 4);
                    if (Crc(png, p + 4, n + 4) != Big32(png, p + 8 + n))
                        throw new InvalidDataException("Saved preview PNG checksum is invalid.");
                    if (type == "IHDR" && p != 8) throw new InvalidDataException("Duplicate PNG header.");
                    if (type == "acTL") throw new InvalidDataException("Animated PNG previews are not supported.");
                    if (type == "IDAT") data = true;
                    bool required = type == "IHDR" || type == "PLTE" || type == "tRNS" ||
                        type == "IDAT" || type == "IEND";
                    if (!required && (png[p + 4] & 32) == 0)
                        throw new InvalidDataException("Unsupported critical PNG chunk.");
                    // Do not hand compressed metadata (profiles/text) to GDI+: its
                    // expanded size is unrelated to the bounded image dimensions.
                    if (required) pixelsOnly.Write(png, p, n + 12);
                    p += n + 12;
                    if (type == "IEND")
                    {
                        if (n != 0 || p != png.Length || !data)
                            throw new InvalidDataException("Malformed PNG end.");
                        ended = true;
                        break;
                    }
                }
                if (!ended) throw new InvalidDataException("Missing PNG end.");
                pixelsOnly.Position = 0;
                using (Image image = Image.FromStream(pixelsOnly, false, true))
                {
                    if (image.Width != width || image.Height != height) throw new InvalidDataException("PNG dimensions disagree.");
                    // Clone pixels so neither GDI+ nor the pane retains the encoded stream.
                    Bitmap bitmap = new Bitmap(image.Width, image.Height, PixelFormat.Format32bppPArgb);
                    try
                    {
                        using (Graphics graphics = Graphics.FromImage(bitmap))
                            graphics.DrawImageUnscaled(image, 0, 0);
                        return bitmap;
                    }
                    catch { bitmap.Dispose(); throw; }
                }
            }
        }

        internal static uint Crc(byte[] bytes, int offset, int count)
        {
            uint crc = uint.MaxValue;
            for (int i = offset; i < offset + count; ++i)
            {
                crc ^= bytes[i];
                for (int b = 0; b < 8; ++b)
                    crc = (crc >> 1) ^ ((crc & 1) != 0 ? 0xedb88320u : 0);
            }
            return ~crc;
        }

        private static byte[] Bytes(Stream stream, int count)
        {
            byte[] result = new byte[count];
            for (int at = 0; at < count;)
            {
                int read = stream.Read(result, at, count - at);
                if (read <= 0) throw new InvalidDataException("Truncated project archive.");
                at += read;
            }
            return result;
        }

        private static int U16(byte[] b, int p) { return b[p] | b[p + 1] << 8; }
        private static uint U32(byte[] b, int p) { return (uint)(b[p] | b[p + 1] << 8 | b[p + 2] << 16 | b[p + 3] << 24); }
        private static uint Big32(byte[] b, int p) { return (uint)(b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]); }
        private static InvalidDataException BadZip() { return new InvalidDataException("Malformed ScanRuler ZIP archive."); }
    }
}
