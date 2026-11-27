// SPDX-License-Identifier: AGPL-3.0-only
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Threading;
using System.Windows.Forms;
using STATSTG = System.Runtime.InteropServices.ComTypes.STATSTG;

[assembly: AssemblyVersion("1.0.0.0")]
[assembly: ComVisible(false)]
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("ScanRuler.ProjectPreview.Tests")]

namespace ScanRuler.ProjectPreview
{
    [ComVisible(true), Guid("B7D14566-0509-4CCE-A71F-0A2B1A87B76B"),
     ClassInterface(ClassInterfaceType.None)]
    public sealed class PreviewHandler : IInitializeWithStream, IPreviewHandler, IObjectWithSite
    {
        private const int Ok = 0, False = 1, Fail = unchecked((int)0x80004005);
        private const int InvalidArgument = unchecked((int)0x80070057);
        private IStream source;
        private object site;
        private IntPtr parent;
        private Rect bounds;
        private PreviewPane pane;
        private UiThread ui;

        ~PreviewHandler()
        {
            if (ui != null) ui.Shutdown(false);
        }

        public int Initialize(IStream stream, uint mode)
        {
            if (stream == null) return InvalidArgument;
            if (source != null || pane != null) return unchecked((int)0x800704df);
            if ((mode & 3) != 0) return unchecked((int)0x80030005);
            source = stream;
            return Ok;
        }

        public int SetWindow(IntPtr hwnd, ref Rect rect)
        {
            if (!Native.IsWindow(hwnd) || !Valid(rect)) return InvalidArgument;
            parent = hwnd;
            bounds = rect;
            return Guard(delegate { if (pane != null) ui.Run(Attach); });
        }

        public int SetRect(ref Rect rect)
        {
            if (!Valid(rect)) return InvalidArgument;
            bounds = rect;
            Rectangle area = Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
            return Guard(delegate { if (pane != null) ui.Run(delegate { pane.Bounds = area; }); });
        }

        public int DoPreview()
        {
            if (source == null || !Native.IsWindow(parent) || pane != null) return Fail;
            return Guard(delegate
            {
                // The caller's stream proxy belongs to this apartment, so read it here, not on the UI thread.
                Bitmap image = null;
                string status = null;
                try
                {
                    using (ComReadStream input = new ComReadStream(source))
                        image = PreviewImage.Read(input);
                }
                catch (Exception error)
                {
                    Trace.TraceError("ScanRuler project preview: {0}", error);
                    status = "Unable to display saved preview. " +
                        (error is InvalidDataException ? error.Message : "The project could not be read.");
                }
                finally { source = null; }
                try
                {
                    if (ui == null) ui = new UiThread();
                    ui.Run(delegate
                    {
                        pane = new PreviewPane();
                        pane.SetContent(image, status);
                        image = null;
                        try { Attach(); }
                        catch { pane.Dispose(); pane = null; throw; }
                    });
                }
                finally { if (image != null) image.Dispose(); }
            });
        }

        private void Attach()
        {
            pane.Bounds = Rectangle.FromLTRB(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom);
            Native.SetLastError(0);
            IntPtr previous = Native.SetParent(pane.Handle, parent);
            int error = Marshal.GetLastWin32Error();
            if (previous == IntPtr.Zero && error != 0) throw new System.ComponentModel.Win32Exception(error);
            pane.Visible = true;
        }

        public int Unload()
        {
            return Guard(delegate
            {
                source = null;
                if (ui != null)
                {
                    UiThread owner = ui;
                    ui = null;
                    owner.Run(delegate { if (pane != null) { pane.Dispose(); pane = null; } });
                    owner.Shutdown(true);
                }
                parent = IntPtr.Zero;
                site = null;
            });
        }

        public int SetFocus()
        {
            if (pane == null) return Fail;
            return Guard(delegate { ui.Run(delegate { pane.Focus(); }); });
        }

        public int QueryFocus(out IntPtr hwnd)
        {
            IntPtr focused = IntPtr.Zero;
            int result = ui == null ? Fail : Guard(delegate { ui.Run(delegate { focused = Native.GetFocus(); }); });
            hwnd = focused;
            return result != Ok ? result : focused == IntPtr.Zero ? Fail : Ok;
        }

        public int TranslateAccelerator(ref MessageData message)
        {
            IPreviewHandlerFrame frame = site as IPreviewHandlerFrame;
            if (frame == null) return False;
            try { return frame.TranslateAccelerator(ref message); }
            catch (Exception error) { Trace.TraceError("ScanRuler preview accelerator: {0}", error); return Marshal.GetHRForException(error); }
        }

        public int SetSite(object value) { site = value; return Ok; }

        public int GetSite(ref Guid iid, out IntPtr value)
        {
            value = IntPtr.Zero;
            if (site == null) return Fail;
            IntPtr unknown = IntPtr.Zero;
            try
            {
                unknown = Marshal.GetIUnknownForObject(site);
                return Marshal.QueryInterface(unknown, ref iid, out value);
            }
            catch (Exception error) { Trace.TraceError("ScanRuler preview site: {0}", error); return Marshal.GetHRForException(error); }
            finally { if (unknown != IntPtr.Zero) Marshal.Release(unknown); }
        }

        private static bool Valid(Rect rect)
        {
            return rect.Right >= rect.Left && rect.Bottom >= rect.Top &&
                (long)rect.Right - rect.Left <= int.MaxValue &&
                (long)rect.Bottom - rect.Top <= int.MaxValue;
        }

        private static int Guard(Action action)
        {
            try { action(); return Ok; }
            catch (Exception error) { Trace.TraceError("ScanRuler preview handler: {0}", error); return Marshal.GetHRForException(error); }
        }
    }

    // Surrogate calls arrive on non-pumping RPC threads because managed COM objects are agile,
    // so the pane window lives on a dedicated STA thread with its own message loop.
    internal sealed class UiThread
    {
        private readonly Control marshal;
        private readonly Thread thread;

        internal UiThread()
        {
            Control created = null;
            Exception failure = null;
            using (ManualResetEvent ready = new ManualResetEvent(false))
            {
                thread = new Thread(delegate()
                {
                    try { created = new Control(); created.CreateControl(); }
                    catch (Exception error) { failure = error; }
                    finally { ready.Set(); }
                    if (failure != null) return;
                    try { Application.Run(); }
                    catch (Exception error) { Trace.TraceError("ScanRuler preview UI thread: {0}", error); }
                    finally { created.Dispose(); }
                });
                thread.Name = "ScanRuler preview UI";
                thread.IsBackground = true;
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
                ready.WaitOne();
            }
            if (failure != null) throw new InvalidOperationException("Preview UI thread failed to start.", failure);
            marshal = created;
        }

        internal void Run(Action action)
        {
            if (marshal.InvokeRequired) marshal.Invoke(action);
            else action();
        }

        internal void Shutdown(bool wait)
        {
            try
            {
                if (wait) { Run(Application.ExitThread); thread.Join(5000); }
                else marshal.BeginInvoke(new Action(Application.ExitThread));
            }
            catch (Exception error) { Trace.TraceError("ScanRuler preview UI shutdown: {0}", error); }
        }
    }

    internal sealed class PreviewPane : Control
    {
        private Bitmap image;
        internal string Status { get; private set; }

        internal PreviewPane()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer | ControlStyles.Selectable, true);
            BackColor = Color.FromArgb(245, 245, 245);
            TabStop = true;
        }

        internal void SetContent(Bitmap value, string error)
        {
            if (image != null) image.Dispose();
            image = value;
            Status = error ?? (image == null ? PreviewImage.MissingMessage : null);
            Invalidate();
        }

        internal static Rectangle Fit(Size area, Size imageSize)
        {
            int width = Math.Max(0, area.Width - 16), height = Math.Max(0, area.Height - 16);
            if (width == 0 || height == 0 || imageSize.Width <= 0 || imageSize.Height <= 0) return Rectangle.Empty;
            double scale = Math.Min((double)width / imageSize.Width, (double)height / imageSize.Height);
            int w = Math.Max(1, (int)(imageSize.Width * scale)), h = Math.Max(1, (int)(imageSize.Height * scale));
            return new Rectangle((area.Width - w) / 2, (area.Height - h) / 2, w, h);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (image != null)
            {
                Rectangle target = Fit(ClientSize, image.Size);
                if (!target.IsEmpty)
                {
                    e.Graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    e.Graphics.DrawImage(image, target);
                    e.Graphics.DrawRectangle(Pens.Gray, target.X - 1, target.Y - 1, target.Width + 1, target.Height + 1);
                }
            }
            else
                TextRenderer.DrawText(e.Graphics, Status ?? "", Font,
                    Rectangle.Inflate(ClientRectangle, -12, -12), Color.FromArgb(45, 45, 45),
                    TextFormatFlags.WordBreak | TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            if (Width > 1 && Height > 1) e.Graphics.DrawRectangle(Pens.Silver, 0, 0, Width - 1, Height - 1);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && image != null) { image.Dispose(); image = null; }
            base.Dispose(disposing);
        }
    }

    internal sealed class ComReadStream : Stream
    {
        private IStream stream;
        private IntPtr scratch = Marshal.AllocCoTaskMem(8);
        internal ComReadStream(IStream value) { stream = value; }
        public override bool CanRead { get { return stream != null; } }
        public override bool CanSeek { get { return stream != null; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { STATSTG stat; stream.Stat(out stat, 1); return stat.cbSize; } }
        public override long Position { get { return Seek(0, SeekOrigin.Current); } set { Seek(value, SeekOrigin.Begin); } }
        public override long Seek(long offset, SeekOrigin origin)
        {
            stream.Seek(offset, (int)origin, scratch);
            long value = Marshal.ReadInt64(scratch);
            if (value < 0) throw new IOException("Invalid project stream position.");
            return value;
        }
        public override int Read(byte[] buffer, int offset, int count)
        {
            if (buffer == null || offset < 0 || count < 0 || offset > buffer.Length - count)
                throw new ArgumentOutOfRangeException();
            byte[] target = offset == 0 ? buffer : new byte[count];
            Marshal.WriteInt32(scratch, 0);
            stream.Read(target, count, scratch);
            int read = Marshal.ReadInt32(scratch);
            if (read < 0 || read > count) throw new IOException("Invalid project stream read.");
            if (offset != 0) Buffer.BlockCopy(target, 0, buffer, offset, read);
            return read;
        }
        public override void Flush() { }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
        protected override void Dispose(bool disposing)
        {
            // The caller/CLR owns the IStream RCW. Never FinalRelease a shared RCW.
            stream = null;
            if (scratch != IntPtr.Zero) { Marshal.FreeCoTaskMem(scratch); scratch = IntPtr.Zero; }
            base.Dispose(disposing);
        }
    }

    [StructLayout(LayoutKind.Sequential), ComVisible(true)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential), ComVisible(true)]
    public struct MessageData
    {
        public IntPtr Hwnd;
        public uint Message;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public int X, Y;
        public uint Private;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct FrameInfo { public IntPtr Accelerator; public uint Count; }

    [ComVisible(true), Guid("B824B49D-22AC-4161-AC8A-9916E8FA3F7F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IInitializeWithStream
    {
        [PreserveSig] int Initialize([MarshalAs(UnmanagedType.Interface)] IStream stream, uint mode);
    }
    [ComVisible(true), Guid("8895B1C6-B41F-4C1C-A562-0D564250836F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPreviewHandler
    {
        [PreserveSig] int SetWindow(IntPtr hwnd, ref Rect rect);
        [PreserveSig] int SetRect(ref Rect rect);
        [PreserveSig] int DoPreview();
        [PreserveSig] int Unload();
        [PreserveSig] int SetFocus();
        [PreserveSig] int QueryFocus(out IntPtr hwnd);
        [PreserveSig] int TranslateAccelerator(ref MessageData message);
    }
    [ComVisible(true), Guid("FC4801A3-2BA9-11CF-A229-00AA003D7352"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IObjectWithSite
    {
        [PreserveSig] int SetSite([MarshalAs(UnmanagedType.IUnknown)] object site);
        [PreserveSig] int GetSite(ref Guid iid, out IntPtr site);
    }
    [ComImport, Guid("FEC87AAF-35F9-447A-ADB7-20234491401A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPreviewHandlerFrame
    {
        [PreserveSig] int GetWindowContext(out FrameInfo info);
        [PreserveSig] int TranslateAccelerator(ref MessageData message);
    }

    internal static class Native
    {
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr SetParent(IntPtr child, IntPtr parent);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] internal static extern IntPtr GetFocus();
        [DllImport("kernel32.dll")] internal static extern void SetLastError(uint error);
    }
}
