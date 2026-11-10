// SPDX-License-Identifier: AGPL-3.0-only
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using ScanRuler.ProjectPreview;
using STATSTG = System.Runtime.InteropServices.ComTypes.STATSTG;

internal static class Tests
{
    private static int passed;
    private static byte[] png;

    [STAThread]
    private static int Main()
    {
        try
        {
            using (Bitmap image = new Bitmap(100, 50))
            using (Graphics graphics = Graphics.FromImage(image))
            using (MemoryStream bytes = new MemoryStream())
            {
                graphics.Clear(Color.CornflowerBlue);
                image.Save(bytes, ImageFormat.Png);
                png = bytes.ToArray();
            }
            Run("stored PNG with compressed project.json", StoredPreview);
            Run("legacy project has explicit missing message", Legacy);
            Run("malformed and unsupported ZIP headers", InvalidArchives);
            Run("encoded preview size limit", EncodedLimit);
            Run("PNG dimensions checked before GDI+ decoding", Dimensions);
            Run("PNG signature, chunks, checksums and truncation", InvalidPng);
            Run("PNG compressed metadata excluded from decoder", Metadata);
            Run("member count and cumulative headers bounded", HeaderLimits);
            Run("large members skipped by seek without reading payload", SparseArchive);
            Run("partial stream reads", PartialReads);
            Run("aspect fit retains border through resize", Render);
            Run("COM CCW native vtable lifecycle and host parenting", ComHarness);
            Run("error pane distinguishes legacy and reports Trace", ErrorPane);
            Run("unload repeated safely; stream remains caller-owned", RepeatedUnload);
            Run("surrogate-style MTA calls keep a pumping pane thread", MtaCalls);
            Console.WriteLine("PASS {0} focused parser/render/COM tests; no registration or registry writes.", passed);
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }

    private static void Run(string name, Action test) { test(); ++passed; Console.WriteLine("PASS " + name); }
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static Entry Project() { return new Entry("project.json", Encoding.UTF8.GetBytes("{}")); }
    private static Entry ImageEntry() { return new Entry("preview.png", png); }
    private static byte[] ProjectArchive() { return Archive(Project(), ImageEntry()); }
    private static Bitmap Read(byte[] zip) { using (MemoryStream stream = new MemoryStream(zip, false)) return PreviewImage.Read(stream); }
    private static void Reject(byte[] zip, string message)
    {
        try { using (Bitmap result = Read(zip)) { } }
        catch (InvalidDataException error)
        {
            Check(error.Message.IndexOf(message, StringComparison.OrdinalIgnoreCase) >= 0,
                "Unexpected error: " + error.Message + "; expected " + message);
            return;
        }
        throw new Exception("Invalid archive was accepted: " + message);
    }

    private static void StoredPreview()
    {
        Entry project = Project();
        project.Method = 8;
        using (Bitmap result = Read(Archive(project, ImageEntry(), new Entry("scan.stl", new byte[7]))))
        {
            Check(result.Width == 100 && result.Height == 50, "Wrong image dimensions.");
            Check(result.GetPixel(20, 20).ToArgb() == Color.CornflowerBlue.ToArgb(), "Wrong image pixels.");
        }
    }

    private static void Legacy()
    {
        Check(Read(Archive(Project(), new Entry("scan.stl", new byte[4]))) == null, "Legacy should not synthesize an image.");
        using (PreviewPane pane = new PreviewPane())
        {
            pane.SetContent(null, null);
            Check(pane.Status == "No saved preview. Open and save this project in a preview-enabled ScanRuler version.", "Wrong legacy instruction.");
        }
        byte[] zip = Archive(Project());
        zip[zip.Length - 22 - 46 - "project.json".Length] = 0;
        Reject(zip, "Malformed");
        zip = Archive(Project());
        zip[zip.Length - 22 - 46 - "project.json".Length + 16] ^= 1;
        Reject(zip, "Malformed");
    }

    private static void InvalidArchives()
    {
        Reject(new byte[4], "Malformed");
        Reject(Archive(new Entry("other.json", new byte[2]), ImageEntry()), "first");
        Entry encrypted = Project(); encrypted.Flags = 1;
        Reject(Archive(encrypted, ImageEntry()), "Encrypted");
        Entry descriptor = Project(); descriptor.Flags = 8;
        Reject(Archive(descriptor, ImageEntry()), "descriptors");
        Entry unsupported = Project(); unsupported.Method = 12;
        Reject(Archive(unsupported, ImageEntry()), "compression");
        Entry compressedImage = ImageEntry(); compressedImage.Method = 8;
        Reject(Archive(Project(), compressedImage), "without ZIP compression");
        byte[] zip = ProjectArchive();
        Array.Resize(ref zip, zip.Length - 3);
        Reject(zip, "Malformed");
        zip = ProjectArchive(); zip[zip.Length - 18] = 1;
        Reject(zip, "Multi-disk");
        zip = ProjectArchive(); Put32(zip, zip.Length - 6, uint.MaxValue);
        Reject(zip, "ZIP64");
        zip = ProjectArchive(); Put32(zip, 18, uint.MaxValue);
        Reject(zip, "ZIP64");
        zip = ProjectArchive(); Put32(zip, 22, 3);
        Reject(zip, "Malformed");
        zip = ProjectArchive(); zip[30 + "project.json".Length + 2 + 30 + "preview.png".Length + 20] ^= 1;
        Reject(zip, "ZIP checksum");
    }

    private static void EncodedLimit()
    {
        Reject(Archive(Project(), new Entry("preview.png", new byte[PreviewImage.MaxEncodedBytes + 1])), "size limit");
        Reject(Archive(Project(), new Entry("preview.png", new byte[0])), "size limit");
    }

    private static void Dimensions()
    {
        byte[] oversized = (byte[])png.Clone();
        PutBig32(oversized, 16, 2049);
        Reject(Archive(Project(), new Entry("preview.png", oversized)), "dimensions");
        PutBig32(oversized, 16, 0);
        Reject(Archive(Project(), new Entry("preview.png", oversized)), "dimensions");
        using (Bitmap image = new Bitmap(2048, 1))
        using (MemoryStream bytes = new MemoryStream())
        {
            image.Save(bytes, ImageFormat.Png);
            using (Bitmap result = PreviewImage.Decode(bytes.ToArray()))
                Check(result.Width == 2048, "Maximum dimension should be accepted.");
        }
    }

    private static void InvalidPng()
    {
        byte[] bad = (byte[])png.Clone(); bad[0] = 0;
        Reject(Archive(Project(), new Entry("preview.png", bad)), "valid PNG");
        bad = (byte[])png.Clone(); bad[29] ^= 1;
        Reject(Archive(Project(), new Entry("preview.png", bad)), "PNG checksum");
        bad = (byte[])png.Clone(); PutBig32(bad, 33, uint.MaxValue);
        Reject(Archive(Project(), new Entry("preview.png", bad)), "Truncated PNG");
        bad = (byte[])png.Clone(); Array.Resize(ref bad, bad.Length - 12);
        Reject(Archive(Project(), new Entry("preview.png", bad)), "PNG");
        bad = (byte[])png.Clone(); bad[26] = 1;
        Reject(Archive(Project(), new Entry("preview.png", bad)), "encoding");
    }

    private static void HeaderLimits()
    {
        byte[] zip = ProjectArchive();
        zip[zip.Length - 12] = 1; zip[zip.Length - 11] = 16;
        Reject(zip, "member count");
        Reject(Archive(new Entry(new string('x', 4097), new byte[0])), "header");
        List<Entry> entries = new List<Entry>();
        entries.Add(Project());
        for (int i = 0; i < 540; ++i) entries.Add(new Entry(new string('x', 4000), new byte[0]));
        Reject(Archive(entries.ToArray()), "header");
    }

    private static void Metadata()
    {
        byte[] chunk;
        using (MemoryStream bytes = new MemoryStream())
        {
            byte[] type = Encoding.ASCII.GetBytes("iCCP");
            byte[] payload = new byte[] { 120, 0, 0, 255, 255, 255 };
            byte[] header = new byte[4]; PutBig32(header, 0, (uint)payload.Length);
            bytes.Write(header, 0, 4); bytes.Write(type, 0, 4); bytes.Write(payload, 0, payload.Length);
            byte[] content = bytes.ToArray();
            byte[] checksum = new byte[4];
            PutBig32(checksum, 0, PreviewImage.Crc(content, 4, content.Length - 4));
            bytes.Write(checksum, 0, 4);
            chunk = bytes.ToArray();
        }
        byte[] withMetadata = new byte[png.Length + chunk.Length];
        Buffer.BlockCopy(png, 0, withMetadata, 0, 33);
        Buffer.BlockCopy(chunk, 0, withMetadata, 33, chunk.Length);
        Buffer.BlockCopy(png, 33, withMetadata, 33 + chunk.Length, png.Length - 33);
        using (Bitmap result = Read(Archive(Project(), new Entry("preview.png", withMetadata))))
            Check(result.GetPixel(20, 20).ToArgb() == Color.CornflowerBlue.ToArgb(), "Metadata affected pixel decode.");
    }

    private static void SparseArchive()
    {
        // A 1 GiB scan is represented by a hole, not allocated or written to disk.
        Entry scan = new Entry("scan.stl", new byte[0]); scan.LogicalLength = 1024 * 1024 * 1024;
        using (SegmentStream stream = MakeArchive(Project(), scan, ImageEntry()))
        using (Bitmap result = PreviewImage.Read(stream))
        {
            Check(result != null, "Preview after a huge member not found.");
            Check(stream.BytesRead < 100000, "Scan payload was read.");
            Check(stream.LargestSeek >= scan.LogicalLength, "Large member was not skipped by seek.");
        }
        using (SegmentStream stream = MakeArchive(Project(), scan))
        {
            Check(PreviewImage.Read(stream) == null, "Large legacy archive result.");
            Check(stream.BytesRead < 100000, "Legacy scan payload was read.");
        }
    }

    private static void PartialReads()
    {
        using (SegmentStream stream = MakeArchive(Project(), ImageEntry()))
        {
            stream.ReadLimit = 3;
            using (Bitmap result = PreviewImage.Read(stream)) Check(result.Width == 100, "Short reads failed.");
        }
    }

    private static void Render()
    {
        Check(PreviewPane.Fit(new Size(416, 216), new Size(100, 50)) == new Rectangle(8, 8, 400, 200), "Wide fit.");
        Check(PreviewPane.Fit(new Size(216, 416), new Size(100, 50)) == new Rectangle(8, 158, 200, 100), "Tall fit.");
        Check(PreviewPane.Fit(new Size(1, 1), new Size(100, 50)).IsEmpty, "Tiny pane fit.");
        using (PreviewPane pane = new PreviewPane())
        {
            pane.SetContent(new Bitmap(100, 50), null);
            foreach (Size size in new[] { new Size(416, 216), new Size(216, 416), new Size(1200, 800) })
            {
                pane.Size = size;
                using (Bitmap rendered = new Bitmap(size.Width, size.Height))
                {
                    pane.DrawToBitmap(rendered, new Rectangle(Point.Empty, size));
                    Check(rendered.GetPixel(0, 0).ToArgb() == Color.Silver.ToArgb(), "Outer border not retained.");
                    Rectangle target = PreviewPane.Fit(size, new Size(100, 50));
                    Check(rendered.GetPixel(target.X - 1, target.Y - 1).ToArgb() == Color.Gray.ToArgb(), "Image border not retained.");
                }
            }
        }
    }

    private static void ComHarness()
    {
        Check(Marshal.SizeOf(typeof(Rect)) == 16 && Marshal.SizeOf(typeof(MessageData)) == 48, "x64 ABI structure size.");
        PreviewHandler handler = new PreviewHandler();
        IntPtr unknown = Marshal.GetIUnknownForObject(handler);
        IntPtr preview = IntPtr.Zero, initialize = IntPtr.Zero, site = IntPtr.Zero;
        IStream stream = SHCreateMemStream(ProjectArchive(), (uint)ProjectArchive().Length);
        IntPtr nativeStream = Marshal.GetComInterfaceForObject(stream, typeof(IStream));
        using (Form host = new Form())
        using (Form otherHost = new Form())
        {
            host.Show(); otherHost.Show(); Application.DoEvents();
            try
            {
                Guid iid = typeof(IPreviewHandler).GUID;
                Check(Marshal.QueryInterface(unknown, ref iid, out preview) == 0, "IPreviewHandler QI.");
                iid = typeof(IInitializeWithStream).GUID;
                Check(Marshal.QueryInterface(unknown, ref iid, out initialize) == 0, "IInitializeWithStream QI.");
                iid = typeof(IObjectWithSite).GUID;
                Check(Marshal.QueryInterface(unknown, ref iid, out site) == 0, "IObjectWithSite QI.");
                Rect rect = new Rect { Left = 10, Top = 20, Right = 310, Bottom = 220 };
                WindowCall setWindow = Slot<WindowCall>(preview, 3);
                Check(setWindow(preview, host.Handle, ref rect) == 0, "Native SetWindow.");
                Check(Slot<InitializeCall>(initialize, 3)(initialize, nativeStream, 0) == 0, "Native Initialize.");
                Check(Slot<SimpleCall>(preview, 5)(preview) == 0, "Native DoPreview.");
                Application.DoEvents();
                IntPtr child = FindWindowEx(host.Handle, IntPtr.Zero, null, null);
                Check(child != IntPtr.Zero && GetParent(child) == host.Handle, "Pane not parented into host.");
                Rect actual; Check(GetWindowRect(child, out actual), "GetWindowRect.");
                Check(actual.Right - actual.Left == 300 && actual.Bottom - actual.Top == 200, "Initial pane bounds.");
                rect.Right = 610; rect.Bottom = 420;
                Check(Slot<RectCall>(preview, 4)(preview, ref rect) == 0, "Native SetRect.");
                GetWindowRect(child, out actual);
                Check(actual.Right - actual.Left == 600 && actual.Bottom - actual.Top == 400, "Resized pane bounds.");
                Check(setWindow(preview, otherHost.Handle, ref rect) == 0 && GetParent(child) == otherHost.Handle, "Reparenting.");
                Check(Slot<SimpleCall>(preview, 7)(preview) == 0, "Native SetFocus.");
                IntPtr focused;
                Check(Slot<FocusCall>(preview, 8)(preview, out focused) == 0 && focused == child, "Native QueryFocus.");
                MessageData message = new MessageData();
                Check(Slot<AcceleratorCall>(preview, 9)(preview, ref message) == 1, "Unhandled accelerator must return S_FALSE.");
                Check(Slot<SimpleCall>(preview, 6)(preview) == 0, "Native Unload.");
                Check(!IsWindow(child), "Pane HWND leaked after Unload.");
            }
            finally
            {
                handler.Unload();
                Marshal.Release(nativeStream);
                Marshal.ReleaseComObject(stream);
                if (site != IntPtr.Zero) Marshal.Release(site);
                if (initialize != IntPtr.Zero) Marshal.Release(initialize);
                if (preview != IntPtr.Zero) Marshal.Release(preview);
                Marshal.Release(unknown);
            }
        }
    }

    private static void ErrorPane()
    {
        using (Form host = new Form())
        {
            host.Show();
            PreviewHandler handler = new PreviewHandler();
            Rect rect = new Rect { Right = 500, Bottom = 300 };
            handler.SetWindow(host.Handle, ref rect);
            byte[] bad = new byte[32];
            IStream stream = SHCreateMemStream(bad, (uint)bad.Length);
            StringWriter log = new StringWriter();
            TextWriterTraceListener listener = new TextWriterTraceListener(log);
            Trace.Listeners.Add(listener);
            try
            {
                Check(handler.Initialize(stream, 0) == 0 && handler.DoPreview() == 0, "Error pane lifecycle.");
                PreviewPane pane = (PreviewPane)typeof(PreviewHandler).GetField("pane",
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance).GetValue(handler);
                Check(pane.Status.StartsWith("Unable to display saved preview.") && pane.Status != PreviewImage.MissingMessage, "Malformed confused with legacy.");
                Trace.Flush();
                Check(log.ToString().Contains("InvalidDataException"), "Missing exception Trace.");
            }
            finally { handler.Unload(); Trace.Listeners.Remove(listener); listener.Dispose(); Marshal.ReleaseComObject(stream); }
        }
    }

    private static void RepeatedUnload()
    {
        PreviewHandler handler = new PreviewHandler();
        Check(handler.Initialize(null, 0) < 0 && handler.DoPreview() < 0, "Invalid lifecycle not rejected.");
        byte[] zip = ProjectArchive();
        IStream stream = SHCreateMemStream(zip, (uint)zip.Length);
        using (Form host = new Form())
        {
            host.Show();
            try
            {
                Check(handler.Initialize(stream, 2) < 0, "Read/write mode accepted.");
                for (int i = 0; i < 20; ++i)
                {
                    Rect rect = new Rect { Right = 400, Bottom = 200 };
                    Check(handler.SetWindow(host.Handle, ref rect) == 0, "SetWindow.");
                    Check(handler.Initialize(stream, 0) == 0, "Initialize.");
                    Check(handler.Initialize(stream, 0) < 0, "Double initialize accepted.");
                    Check(handler.DoPreview() == 0, "DoPreview.");
                    Check(handler.Unload() == 0 && handler.Unload() == 0, "Repeated unload.");
                }
                STATSTG stat; stream.Stat(out stat, 1);
                Check(stat.cbSize == zip.Length, "Borrowed stream released by handler.");
            }
            finally { handler.Unload(); Marshal.ReleaseComObject(stream); }
        }
    }

    private static void MtaCalls()
    {
        PreviewHandler handler = new PreviewHandler();
        byte[] zip = ProjectArchive();
        IStream stream = SHCreateMemStream(zip, (uint)zip.Length);
        using (Form host = new Form())
        {
            host.Show();
            Application.DoEvents();
            IntPtr parent = host.Handle;
            try
            {
                int callerThread = 0;
                OnMta(delegate
                {
                    callerThread = GetCurrentThreadId();
                    Rect rect = new Rect { Right = 320, Bottom = 240 };
                    Check(handler.SetWindow(parent, ref rect) == 0, "MTA SetWindow.");
                    Check(handler.Initialize(stream, 0) == 0, "MTA Initialize.");
                    Check(handler.DoPreview() == 0, "MTA DoPreview.");
                });
                IntPtr child = FindWindowEx(parent, IntPtr.Zero, null, null);
                Check(child != IntPtr.Zero, "MTA pane not parented.");
                uint process;
                int owner = (int)GetWindowThreadProcessId(child, out process);
                Check(owner != callerThread && owner != GetCurrentThreadId(), "Pane created on a caller thread.");
                IntPtr result;
                Check(SendMessageTimeout(child, 0, IntPtr.Zero, IntPtr.Zero, 2, 3000, out result) != IntPtr.Zero,
                    "Pane thread does not pump messages after the caller thread exited.");
                OnMta(delegate
                {
                    Rect rect = new Rect { Right = 500, Bottom = 300 };
                    Check(handler.SetRect(ref rect) == 0, "MTA SetRect.");
                });
                Rect actual;
                Check(GetWindowRect(child, out actual) && actual.Right - actual.Left == 500, "MTA resize.");
                OnMta(delegate { Check(handler.Unload() == 0, "MTA Unload."); });
                Check(!IsWindow(child), "Pane HWND leaked after MTA Unload.");
            }
            finally { handler.Unload(); Marshal.ReleaseComObject(stream); }
        }
    }

    private static void OnMta(Action action)
    {
        Exception failure = null;
        Thread thread = new Thread(delegate() { try { action(); } catch (Exception error) { failure = error; } });
        thread.SetApartmentState(ApartmentState.MTA);
        thread.Start();
        while (thread.IsAlive) { Application.DoEvents(); thread.Join(10); }
        if (failure != null) throw new Exception("MTA call failed.", failure);
    }

    private sealed class Entry
    {
        internal string Name;
        internal byte[] Data;
        internal ushort Method, Flags;
        internal uint LogicalLength;
        internal Entry(string name, byte[] data) { Name = name; Data = data; LogicalLength = (uint)data.Length; }
    }

    private static byte[] Archive(params Entry[] entries)
    {
        using (SegmentStream stream = MakeArchive(entries))
        using (MemoryStream output = new MemoryStream())
        {
            stream.CopyTo(output);
            return output.ToArray();
        }
    }

    private static SegmentStream MakeArchive(params Entry[] entries)
    {
        SegmentStream result = new SegmentStream();
        List<uint> offsets = new List<uint>();
        foreach (Entry entry in entries)
        {
            offsets.Add((uint)result.Length);
            using (MemoryStream bytes = new MemoryStream())
            using (BinaryWriter writer = new BinaryWriter(bytes))
            {
                byte[] name = Encoding.UTF8.GetBytes(entry.Name);
                writer.Write(0x04034b50u); writer.Write((ushort)20);
                writer.Write(entry.Flags); writer.Write(entry.Method); writer.Write(0u);
                writer.Write(PreviewImage.Crc(entry.Data, 0, entry.Data.Length));
                writer.Write(entry.LogicalLength); writer.Write(entry.LogicalLength);
                writer.Write((ushort)name.Length); writer.Write((ushort)0); writer.Write(name);
                result.Append(bytes.ToArray());
            }
            result.Append(entry.Data);
            result.Hole(entry.LogicalLength - entry.Data.Length);
        }
        uint directoryOffset = (uint)result.Length;
        for (int i = 0; i < entries.Length; ++i)
        {
            Entry entry = entries[i];
            using (MemoryStream bytes = new MemoryStream())
            using (BinaryWriter writer = new BinaryWriter(bytes))
            {
                byte[] name = Encoding.UTF8.GetBytes(entry.Name);
                writer.Write(0x02014b50u); writer.Write((ushort)20); writer.Write((ushort)20);
                writer.Write(entry.Flags); writer.Write(entry.Method); writer.Write(0u);
                writer.Write(PreviewImage.Crc(entry.Data, 0, entry.Data.Length));
                writer.Write(entry.LogicalLength); writer.Write(entry.LogicalLength);
                writer.Write((ushort)name.Length); writer.Write((ushort)0); writer.Write((ushort)0);
                writer.Write((ushort)0); writer.Write((ushort)0); writer.Write(0u); writer.Write(offsets[i]); writer.Write(name);
                result.Append(bytes.ToArray());
            }
        }
        uint directorySize = (uint)result.Length - directoryOffset;
        using (MemoryStream bytes = new MemoryStream())
        using (BinaryWriter writer = new BinaryWriter(bytes))
        {
            writer.Write(0x06054b50u); writer.Write((ushort)0); writer.Write((ushort)0);
            writer.Write((ushort)entries.Length); writer.Write((ushort)entries.Length);
            writer.Write(directorySize); writer.Write(directoryOffset); writer.Write((ushort)0);
            result.Append(bytes.ToArray());
        }
        return result;
    }

    private sealed class SegmentStream : Stream
    {
        private readonly List<KeyValuePair<long, byte[]>> parts = new List<KeyValuePair<long, byte[]>>();
        private long length, position;
        internal long BytesRead, LargestSeek;
        internal int ReadLimit = int.MaxValue;
        internal void Append(byte[] bytes) { parts.Add(new KeyValuePair<long, byte[]>(length, bytes)); length += bytes.Length; }
        internal void Hole(long bytes) { length += bytes; }
        public override long Length { get { return length; } }
        public override long Position { get { return position; } set { Seek(value, SeekOrigin.Begin); } }
        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override int Read(byte[] buffer, int offset, int count)
        {
            int n = (int)Math.Min(Math.Min(count, ReadLimit), Math.Max(0, length - position));
            Array.Clear(buffer, offset, n);
            foreach (KeyValuePair<long, byte[]> part in parts)
            {
                long start = Math.Max(position, part.Key), end = Math.Min(position + n, part.Key + part.Value.Length);
                if (start < end) Buffer.BlockCopy(part.Value, (int)(start - part.Key), buffer, offset + (int)(start - position), (int)(end - start));
            }
            position += n; BytesRead += n; return n;
        }
        public override long Seek(long offset, SeekOrigin origin)
        {
            long next = origin == SeekOrigin.Begin ? offset : origin == SeekOrigin.Current ? position + offset : length + offset;
            LargestSeek = Math.Max(LargestSeek, Math.Abs(next - position));
            position = next; return position;
        }
        public override void Flush() { }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    }

    private static void Put32(byte[] bytes, int offset, uint value)
    { for (int i = 0; i < 4; ++i) bytes[offset + i] = (byte)(value >> (8 * i)); }
    private static void PutBig32(byte[] bytes, int offset, uint value)
    { for (int i = 0; i < 4; ++i) bytes[offset + i] = (byte)(value >> (8 * (3 - i))); }
    private static T Slot<T>(IntPtr pointer, int slot) where T : class
    {
        IntPtr table = Marshal.ReadIntPtr(pointer);
        return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, slot * IntPtr.Size), typeof(T));
    }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int SimpleCall(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int WindowCall(IntPtr self, IntPtr hwnd, ref Rect rect);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int RectCall(IntPtr self, ref Rect rect);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int InitializeCall(IntPtr self, IntPtr stream, uint mode);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int FocusCall(IntPtr self, out IntPtr hwnd);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int AcceleratorCall(IntPtr self, ref MessageData message);
    [DllImport("shlwapi.dll")] [return: MarshalAs(UnmanagedType.Interface)] private static extern IStream SHCreateMemStream(byte[] bytes, uint count);
    [DllImport("user32.dll")] private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
    [DllImport("kernel32.dll")] private static extern int GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindow(IntPtr hwnd);
}
