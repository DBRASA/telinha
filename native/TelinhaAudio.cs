// TelinhaAudio: captura o som do PC por programa (Windows 10 2004+ / Windows 11)
// e escreve PCM 48 kHz, estéreo, 16 bits no stdout.
//
//   TelinhaAudio.exe exclude-discord   -> todo o som, menos o Discord
//   TelinhaAudio.exe window <hwnd>     -> só o som do programa dessa janela
//
// Escreve "READY" no stderr quando a captura começou.
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

static class Program
{
    const ushort VT_BLOB = 65;
    const int ACTIVATION_TYPE_PROCESS_LOOPBACK = 1;
    const int LOOPBACK_INCLUDE_TREE = 0;
    const int LOOPBACK_EXCLUDE_TREE = 1;
    const uint STREAMFLAGS_LOOPBACK = 0x00020000;
    const uint STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    const uint STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
    const uint STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
    const uint BUFFERFLAGS_SILENT = 0x2;
    const int RATE = 48000, CHANNELS = 2, BITS = 16, BLOCK = CHANNELS * BITS / 8;

    [StructLayout(LayoutKind.Sequential)]
    struct ActivationParams { public int ActivationType; public uint TargetProcessId; public int LoopbackMode; }

    [StructLayout(LayoutKind.Sequential)]
    struct PropVariant { public ushort vt; public ushort r1, r2, r3; public uint cbSize; public IntPtr pBlobData; }

    [StructLayout(LayoutKind.Sequential)]
    struct WaveFormatEx
    {
        public ushort wFormatTag, nChannels;
        public uint nSamplesPerSec, nAvgBytesPerSec;
        public ushort nBlockAlign, wBitsPerSample, cbSize;
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    [ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject { }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        void Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        void GetBufferSize(out uint frames);
        void GetStreamLatency(out long latency);
        void GetCurrentPadding(out uint padding);
        void IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        void GetMixFormat(out IntPtr format);
        void GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        void Start();
        void Stop();
        void Reset();
        void SetEventHandle(IntPtr handle);
        void GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        void GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        void ReleaseBuffer(uint frames);
        void GetNextPacketSize(out uint frames);
    }

    class CompletionHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int Result;
        public object Client;

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            operation.GetActivateResult(out Result, out Client);
            Done.Set();
        }
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    static extern void ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath, ref Guid riid, IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler, out IActivateAudioInterfaceAsyncOperation operation);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [MTAThread]
    static int Main(string[] args)
    {
        try
        {
            uint pid;
            int mode;
            if (args.Length >= 1 && args[0] == "exclude-discord")
            {
                pid = FindDiscordRoot() ?? (uint)Process.GetCurrentProcess().Id; // sem Discord: exclui só a si mesmo
                mode = LOOPBACK_EXCLUDE_TREE;
            }
            else if (args.Length >= 2 && args[0] == "window")
            {
                GetWindowThreadProcessId(new IntPtr(long.Parse(args[1])), out pid);
                if (pid == 0) throw new Exception("janela não encontrada");
                mode = LOOPBACK_INCLUDE_TREE;
            }
            else
            {
                Console.Error.WriteLine("uso: TelinhaAudio.exe exclude-discord | window <hwnd>");
                return 2;
            }
            Capture(pid, mode);
            return 0;
        }
        catch (IOException)
        {
            return 0; // o Telinha fechou o pipe
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("ERRO " + e.Message);
            return 1;
        }
    }

    // O Discord roda em vários processos; o primeiro a abrir é o pai de todos.
    static uint? FindDiscordRoot()
    {
        var names = new[] { "Discord", "DiscordPTB", "DiscordCanary" };
        var procs = names.SelectMany(Process.GetProcessesByName).ToList();
        Process root = null;
        foreach (var p in procs)
        {
            try { if (root == null || p.StartTime < root.StartTime) root = p; } catch { }
        }
        return root == null ? (uint?)null : (uint)root.Id;
    }

    static void Capture(uint pid, int mode)
    {
        var activation = new ActivationParams { ActivationType = ACTIVATION_TYPE_PROCESS_LOOPBACK, TargetProcessId = pid, LoopbackMode = mode };
        IntPtr pActivation = Marshal.AllocHGlobal(Marshal.SizeOf(activation));
        Marshal.StructureToPtr(activation, pActivation, false);
        var variant = new PropVariant { vt = VT_BLOB, cbSize = (uint)Marshal.SizeOf(activation), pBlobData = pActivation };
        IntPtr pVariant = Marshal.AllocHGlobal(Marshal.SizeOf(variant));
        Marshal.StructureToPtr(variant, pVariant, false);

        var handler = new CompletionHandler();
        var iid = typeof(IAudioClient).GUID;
        IActivateAudioInterfaceAsyncOperation op;
        ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, pVariant, handler, out op);
        handler.Done.WaitOne();
        if (handler.Result != 0) Marshal.ThrowExceptionForHR(handler.Result);
        var client = (IAudioClient)handler.Client;

        var format = new WaveFormatEx
        {
            wFormatTag = 1, nChannels = CHANNELS, nSamplesPerSec = RATE, nAvgBytesPerSec = RATE * BLOCK,
            nBlockAlign = BLOCK, wBitsPerSample = BITS, cbSize = 0,
        };
        IntPtr pFormat = Marshal.AllocHGlobal(Marshal.SizeOf(format));
        Marshal.StructureToPtr(format, pFormat, false);
        client.Initialize(0, STREAMFLAGS_LOOPBACK | STREAMFLAGS_EVENTCALLBACK | STREAMFLAGS_AUTOCONVERTPCM | STREAMFLAGS_SRC_DEFAULT_QUALITY,
            200000, 0, pFormat, IntPtr.Zero);

        var ready = new AutoResetEvent(false);
        client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
        var captureIid = typeof(IAudioCaptureClient).GUID;
        object service;
        client.GetService(ref captureIid, out service);
        var capture = (IAudioCaptureClient)service;

        var stdout = Console.OpenStandardOutput();
        var bytes = new byte[RATE * BLOCK]; // até 1 s por pacote
        client.Start();
        Console.Error.WriteLine("READY");

        while (true)
        {
            ready.WaitOne(100);
            uint packet;
            capture.GetNextPacketSize(out packet);
            while (packet > 0)
            {
                IntPtr data; uint frames, flags; ulong dev, qpc;
                capture.GetBuffer(out data, out frames, out flags, out dev, out qpc);
                int length = (int)Math.Min(frames * BLOCK, (uint)bytes.Length);
                if ((flags & BUFFERFLAGS_SILENT) != 0) Array.Clear(bytes, 0, length);
                else Marshal.Copy(data, bytes, 0, length);
                capture.ReleaseBuffer(frames);
                stdout.Write(bytes, 0, length);
                capture.GetNextPacketSize(out packet);
            }
            stdout.Flush();
        }
    }
}
