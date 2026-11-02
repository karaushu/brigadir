// sim-helper: the screen and input of one booted iOS Simulator device (spec/browser-and-simulator#simulator).
//
// Usage: sim-helper --udid <UDID>. CoreSimulator, SimulatorKit and AccessibilityPlatformTranslation
// are dlopen'ed from the active Xcode; nothing private is linked. No window and no NSApplication,
// so the process never takes focus. Ideas from serve-sim
// (Apache-2.0) and idb FBSimulatorControl (MIT).
//
// stdout carries only frames [u8 type][u32 BE length][payload]:
//   1 JSON event; 2 JSON video config for WebCodecs VideoDecoder.configure;
//   3 video chunk [u8 key][u64 BE timestamp µs][AVCC access unit].
// The timestamp is the capture time on mach_absolute_time, the clock of Node's process.hrtime.
// stdin carries JSON lines; a numeric `id` gets a reply event. EOF or {"cmd":"quit"} exits.
#import <AppKit/AppKit.h>
#import <CoreImage/CoreImage.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <VideoToolbox/VideoToolbox.h>
#include <dlfcn.h>
#include <stdatomic.h>
#include <time.h>
#include <unistd.h>
#include <xpc/xpc.h>

// Private selectors, declared so ARC lets us message `id`.
@protocol SimPrivate
+ (id)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
- (NSArray *)devices;
- (NSUUID *)UDID;
- (NSString *)stateString;
- (id)deviceType;
- (float)mainScreenScale;
- (id)io;
- (void)updateIOPorts;
- (NSArray *)deviceIOPorts;
- (id)portIdentifier;
- (id)descriptor;
- (IOSurfaceRef)framebufferSurface;
- (void)registerScreenCallbacksWithUUID:(NSUUID *)uuid callbackQueue:(dispatch_queue_t)queue frameCallback:(void (^)(void))frame surfacesChangedCallback:(void (^)(void))surfaces propertiesChangedCallback:(void (^)(void))properties;
- (void)unregisterScreenCallbacksWithUUID:(NSUUID *)uuid;
- (mach_port_t)lookup:(NSString *)name error:(NSError **)error;
- (id)initWithDevice:(id)device error:(NSError **)error;
- (void)sendWithMessage:(void *)message freeWhenDone:(BOOL)free completionQueue:(dispatch_queue_t)queue completion:(void (^)(NSError *))completion;
- (void)sendAccessibilityRequestAsync:(id)request completionQueue:(dispatch_queue_t)queue completionHandler:(void (^)(id))handler;
+ (id)sharedInstance;
+ (id)emptyResponse;
- (id)frontmostApplicationWithDisplayId:(unsigned int)display bridgeDelegateToken:(NSString *)token;
- (id)objectAtPoint:(CGPoint)point displayId:(unsigned int)display bridgeDelegateToken:(NSString *)token;
- (id)macPlatformElementFromTranslation:(id)translation;
@end

static id gDevice;

static uint64_t nowUs(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000; }

static dispatch_queue_t serialQueue(const char *name) {
  return dispatch_queue_create(name, dispatch_queue_attr_make_with_autorelease_frequency(DISPATCH_QUEUE_SERIAL, DISPATCH_AUTORELEASE_FREQUENCY_WORK_ITEM));
}

// ---------------------------------------------------------------- output

static dispatch_queue_t gOut;
static atomic_long gQueuedVideo;
static const long kMaxQueuedVideo = 8 << 20;  // beyond this the app is not reading: skip to a keyframe

static void writeAll(NSData *data) {
  const uint8_t *bytes = data.bytes;
  size_t left = data.length;
  while (left) {
    ssize_t n = write(STDOUT_FILENO, bytes, left);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) _exit(0);  // the app closed our stdout: it is gone
    bytes += n;
    left -= (size_t)n;
  }
}

static NSMutableData *frameStart(uint8_t type) {
  NSMutableData *data = [NSMutableData dataWithLength:5];
  ((uint8_t *)data.mutableBytes)[0] = type;
  return data;
}

static void frameSend(NSMutableData *data, BOOL video) {
  uint32_t length = CFSwapInt32HostToBig((uint32_t)(data.length - 5));
  memcpy((uint8_t *)data.mutableBytes + 1, &length, 4);
  long size = (long)data.length;
  if (video) atomic_fetch_add(&gQueuedVideo, size);
  dispatch_async(gOut, ^{
    writeAll(data);
    if (video) atomic_fetch_sub(&gQueuedVideo, size);
  });
}

static void sendJSON(uint8_t type, NSDictionary *object) {
  NSError *error = nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingWithoutEscapingSlashes error:&error];
  if (!json) { fprintf(stderr, "sim-helper: cannot encode JSON: %s\n", error.localizedDescription.UTF8String); return; }
  NSMutableData *data = frameStart(type);
  [data appendData:json];
  frameSend(data, NO);
}

static void emit(NSDictionary *event) { sendJSON(1, event); }

static void warn(NSString *message) {
  fprintf(stderr, "sim-helper: %s\n", message.UTF8String);
  emit(@{@"event": @"error", @"message": message, @"fatal": @NO});
}

// Never call from gOut.
static void fail(NSString *message) {
  fprintf(stderr, "sim-helper: %s\n", message.UTF8String);
  emit(@{@"event": @"error", @"message": message, @"fatal": @YES});
  dispatch_sync(gOut, ^{});
  exit(1);
}

static void reply(NSNumber *requestId, id result, NSString *error) {
  if (!requestId) { if (error) warn(error); return; }
  if (error) emit(@{@"event": @"reply", @"id": requestId, @"error": error});
  else emit(@{@"event": @"reply", @"id": requestId, @"result": result ?: @YES});
}

// ---------------------------------------------------------------- device

static NSString *developerDir(void) {
  NSTask *task = [NSTask new];
  task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xcode-select"];
  task.arguments = @[@"-p"];
  NSPipe *pipe = [NSPipe pipe];
  task.standardOutput = pipe;
  task.standardError = [NSFileHandle fileHandleWithNullDevice];
  if (![task launchAndReturnError:nil]) return nil;
  NSData *data = [pipe.fileHandleForReading readDataToEndOfFile];
  [task waitUntilExit];
  if (task.terminationStatus != 0) return nil;
  NSString *path = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  path = [path stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  return path.length ? path : nil;
}

// Returns an error sentence, or nil when the device is found and booted.
static NSString *openDevice(NSString *udid) {
  NSString *developer = developerDir();
  if (!developer) return @"No Xcode is selected; install Xcode and run xcode-select.";
  if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW))
    return @"CoreSimulator is missing; open Xcode once to install its components.";
  // Xcode 27 keeps SimulatorKit in SharedFrameworks, earlier versions in the developer dir.
  if (!dlopen([developer stringByAppendingPathComponent:@"../SharedFrameworks/SimulatorKit.framework/SimulatorKit"].fileSystemRepresentation, RTLD_NOW) &&
      !dlopen([developer stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"].fileSystemRepresentation, RTLD_NOW))
    return @"SimulatorKit is missing from the selected Xcode.";
  Class context = NSClassFromString(@"SimServiceContext");
  if (!context) return @"This CoreSimulator is not supported.";
  NSError *error = nil;
  id set = [[(id<SimPrivate>)context sharedServiceContextForDeveloperDir:developer error:&error] defaultDeviceSetWithError:&error];
  if (!set) return [NSString stringWithFormat:@"The simulator device set is unavailable: %@.", error.localizedDescription];
  for (id device in [set devices]) {
    if (![[[device UDID] UUIDString] isEqualToString:udid]) continue;
    if (![[device stateString] isEqualToString:@"Booted"]) return @"The device is not booted.";
    gDevice = device;
    return nil;
  }
  return @"No simulator device has this UDID.";
}

static BOOL deviceBooted(void) { return [[gDevice stateString] isEqualToString:@"Booted"]; }

// ---------------------------------------------------------------- input
//
// Xcode 27 (CoreSimulator 1155.4+): the guest daemon dtuhidd owns HID, so input goes as XPC
// messages to its digitizer service; Indigo messages are accepted there and silently lost.
// Earlier versions use SimulatorKit's Indigo HID client.

// Returns +1 like every xpc_*_create: tell ARC, or each reconnect leaks an endpoint.
typedef xpc_object_t (*EndpointFromPortFn)(mach_port_t port, uint64_t a, uint64_t b) __attribute__((ns_returns_retained));
typedef void (*EnableSim2HostFn)(xpc_connection_t connection);
typedef void *(*IndigoMouseFn)(CGPoint *point, CGPoint *second, uint32_t target, int32_t type, CGSize size, uint32_t edge);
typedef void *(*IndigoButtonFn)(int32_t source, int32_t direction, int32_t target);
typedef void *(*IndigoKeyFn)(uint32_t usage, uint32_t direction);

typedef enum { PhaseDown = 0, PhasePosition = 1, PhaseUp = 2 } Phase;  // dtuhidd eventType values

static const char *kDigitizerService = "com.apple.coredevice.feature.remote.hid.digitizer";
static dispatch_queue_t gInput;     // every input operation, in order
static dispatch_queue_t gInputIO;   // XPC events and Indigo completions; never waited on from itself
static BOOL gIndigo;
static xpc_connection_t gXPC;       // gInput only
static id gIndigoClient;            // gInput only
static dispatch_group_t gIndigoPending;

static xpc_object_t dtuMessage(const char *type, xpc_object_t payload, bool barrier) {
  xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(message, "messageType", type);
  xpc_dictionary_set_bool(message, "isBarrier", barrier);
  xpc_dictionary_set_string(message, "featureIdentifier", kDigitizerService);
  xpc_dictionary_set_value(message, "payload", payload);
  return message;
}

static xpc_object_t keyPayload(uint64_t usage, BOOL down) {
  xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(payload, "usageCode", usage);
  xpc_dictionary_set_uint64(payload, "state", down ? 1 : 2);  // dtuhidd rejects 0
  return payload;
}

static void dtuDrop(void) {
  if (gXPC) xpc_connection_cancel(gXPC);
  gXPC = nil;
}

// Liveness barrier: keyboard usage 0 ("no event") with isBarrier; dtuhidd answers with an empty dictionary.
static BOOL dtuBarrier(void) {
  xpc_object_t answer = xpc_connection_send_message_with_reply_sync(gXPC, dtuMessage("IndigoKeyboardButtonEvent", keyPayload(0, NO), true));
  if (xpc_get_type(answer) != XPC_TYPE_ERROR) return YES;
  fprintf(stderr, "sim-helper: input barrier failed: %s\n", xpc_dictionary_get_string(answer, XPC_ERROR_KEY_DESCRIPTION));
  return NO;
}

static mach_port_urefs_t sendRefs(mach_port_t name) {
  mach_port_urefs_t refs = 0;
  return mach_port_get_refs(mach_task_self(), name, MACH_PORT_RIGHT_SEND, &refs) == KERN_SUCCESS ? refs : 0;
}

static NSString *dtuConnect(void) {
  static EndpointFromPortFn endpointFromPort;
  static EnableSim2HostFn enableSim2Host;
  if (!endpointFromPort) endpointFromPort = (EndpointFromPortFn)dlsym(RTLD_DEFAULT, "xpc_endpoint_create_mach_port_4sim");
  if (!enableSim2Host) enableSim2Host = (EnableSim2HostFn)dlsym(RTLD_DEFAULT, "xpc_connection_enable_sim2host_4sim");
  if (!endpointFromPort || !enableSim2Host) return @"This macOS has no simulator XPC bridge for input.";
  // -lookup: hands us send urefs (two on CoreSimulator 1171) that nobody releases, and the
  // connection takes its own. Mach reuses the name for the same port, so an old connection
  // still being torn down may share it: count only what this lookup added.
  static mach_port_t lastPort;
  mach_port_urefs_t before = lastPort ? sendRefs(lastPort) : 0;
  NSError *error = nil;
  mach_port_t port = [gDevice lookup:@(kDigitizerService) error:&error];
  if (port == MACH_PORT_NULL) return [NSString stringWithFormat:@"The device input service is unavailable: %@.", error.localizedDescription];
  mach_port_urefs_t after = sendRefs(port), gained = port == lastPort && after >= before ? after - before : after;
  lastPort = port;
  xpc_object_t endpoint = endpointFromPort(port, 0, 0);
  xpc_connection_t connection = endpoint ? xpc_connection_create_from_endpoint((xpc_endpoint_t)endpoint) : nil;
  if (gained) mach_port_mod_refs(mach_task_self(), port, MACH_PORT_RIGHT_SEND, -(mach_port_delta_t)gained);
  if (!connection) return @"The device input service cannot be reached.";
  enableSim2Host(connection);  // without it dtuhidd sees the client but none of its messages
  xpc_connection_set_target_queue(connection, gInputIO);
  uintptr_t tag = (uintptr_t)(__bridge void *)connection;  // compared by address: the connection owns this handler
  xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
    if (event != XPC_ERROR_CONNECTION_INTERRUPTED && event != XPC_ERROR_CONNECTION_INVALID) return;
    BOOL interrupted = event == XPC_ERROR_CONNECTION_INTERRUPTED;
    dispatch_async(gInput, ^{
      if ((uintptr_t)(__bridge void *)gXPC != tag) return;
      // Interrupted: dtuhidd restarted; re-arm with a barrier. Invalid: reconnect on the next input.
      if (interrupted && dtuBarrier()) return;
      fprintf(stderr, "sim-helper: input connection lost; reconnecting on next input\n");
      dtuDrop();
    });
  });
  xpc_connection_resume(connection);
  gXPC = connection;
  if (!dtuBarrier()) { dtuDrop(); return @"The device input service did not answer."; }
  return nil;
}

static NSString *indigoConnect(void) {
  Class client = NSClassFromString(@"_TtC12SimulatorKit24SimDeviceLegacyHIDClient");
  if (!client) return @"This SimulatorKit has no HID client.";
  NSError *error = nil;
  gIndigoClient = [(id<SimPrivate>)[client alloc] initWithDevice:gDevice error:&error];
  return gIndigoClient ? nil : [NSString stringWithFormat:@"The device HID client failed: %@.", error.localizedDescription];
}

// gInput only. Returns an error sentence, or nil when input can be sent.
static NSString *inputReady(void) {
  if (gIndigo ? gIndigoClient != nil : gXPC != nil) return nil;
  if (!deviceBooted()) return @"The device is not running.";
  return gIndigo ? indigoConnect() : dtuConnect();
}

static void indigoSend(void *message) {
  if (!message) return;  // the builder refuses drags closer than 16 ms apart
  dispatch_group_enter(gIndigoPending);
  [gIndigoClient sendWithMessage:message freeWhenDone:YES completionQueue:gInputIO completion:^(NSError *error) {
    if (error) fprintf(stderr, "sim-helper: HID message failed: %s\n", error.localizedDescription.UTF8String);
    dispatch_group_leave(gIndigoPending);
  }];
}

// A contact that starts on the home indicator carries the bottom edge flag, or iOS takes it for
// an ordinary touch and the swipe home does nothing. Top and side edge gestures need no flag.
static const double kBottomEdge = 0.98;
static const uint32_t kEdgeBottom = 3;

static void sendTouch(double x, double y, Phase phase) {
  static uint32_t edge;  // gInput only
  if (phase == PhaseDown) edge = y >= kBottomEdge ? kEdgeBottom : 0;
  if (gIndigo) {
    static IndigoMouseFn mouse;
    if (!mouse) mouse = (IndigoMouseFn)dlsym(RTLD_DEFAULT, "IndigoHIDMessageForMouseNSEvent");
    CGPoint point = CGPointMake(x, y);
    if (mouse) indigoSend(mouse(&point, NULL, 0x32, phase == PhaseUp ? 2 : 1, CGSizeMake(1, 1), edge));
    return;
  }
  xpc_object_t point = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_double(point, "x", x);
  xpc_dictionary_set_double(point, "y", y);
  xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_value(payload, "pointOne", point);
  xpc_dictionary_set_uint64(payload, "eventType", phase);
  xpc_dictionary_set_uint64(payload, "edge", edge);
  xpc_dictionary_set_uint64(payload, "target", 0);
  xpc_connection_send_message(gXPC, dtuMessage("IndigoDigitizerEvent", payload, false));
}

// Consumer page usage for dtuhidd (Home 0x40 Menu, Lock 0x30 Power); Indigo button source.
static void sendButton(uint64_t usage, int32_t indigoSource, BOOL down) {
  if (gIndigo) {
    static IndigoButtonFn button;
    if (!button) button = (IndigoButtonFn)dlsym(RTLD_DEFAULT, "IndigoHIDMessageForButton");
    if (button) indigoSend(button(indigoSource, down ? 1 : 2, 0x33));
    return;
  }
  xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(payload, "usagePage", 0x0C);
  xpc_dictionary_set_uint64(payload, "usageCode", usage);
  xpc_dictionary_set_uint64(payload, "state", down ? 1 : 2);
  xpc_connection_send_message(gXPC, dtuMessage("IndigoButtonEvent", payload, false));
}

static void sendKey(uint32_t usage, BOOL down) {
  if (gIndigo) {
    static IndigoKeyFn key;
    if (!key) key = (IndigoKeyFn)dlsym(RTLD_DEFAULT, "IndigoHIDMessageForKeyboardArbitrary");
    if (key) indigoSend(key(usage, down ? 1 : 2));
    return;
  }
  xpc_connection_send_message(gXPC, dtuMessage("IndigoKeyboardButtonEvent", keyPayload(usage, down), false));
}

// Wait until everything queued has left for the device.
static void inputFlush(void) {
  dispatch_time_t limit = dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC);
  if (gIndigo) { dispatch_group_wait(gIndigoPending, limit); return; }
  if (!gXPC) return;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  xpc_connection_send_barrier(gXPC, ^{ dispatch_semaphore_signal(done); });
  dispatch_semaphore_wait(done, limit);
}

static void sleepFor(double seconds) { usleep((useconds_t)(seconds * 1e6)); }

static void gesture(double x1, double y1, double x2, double y2, double seconds) {
  sendTouch(x1, y1, PhaseDown);
  int steps = MAX(2, (int)(seconds * 60));  // ~60 Hz, the rate Indigo still accepts
  for (int i = 1; i <= steps; i++) {
    sleepFor(seconds / steps);
    double t = (double)i / steps;
    sendTouch(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, PhasePosition);
  }
  sendTouch(x2, y2, PhaseUp);
}

// ASCII → USB HID keyboard usage (page 7, US layout) and whether Shift is needed.
static BOOL usageForCharacter(unichar c, uint32_t *usage, BOOL *shift) {
  static const char plain[] = "-=[]\\;'`,./", shifted[] = "_+{}|:\"~<>?";
  static const uint32_t symbols[] = {0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38};
  static const char digitsShifted[] = ")!@#$%^&*(";
  *shift = NO;
  if (c >= 'a' && c <= 'z') { *usage = 0x04 + (c - 'a'); return YES; }
  if (c >= 'A' && c <= 'Z') { *usage = 0x04 + (c - 'A'); *shift = YES; return YES; }
  if (c >= '0' && c <= '9') { *usage = c == '0' ? 0x27 : 0x1E + (c - '1'); return YES; }
  if (c == ' ') { *usage = 0x2C; return YES; }
  if (c == '\n') { *usage = 0x28; return YES; }
  if (c == '\t') { *usage = 0x2B; return YES; }
  if (c > 0x7E || c == 0) return NO;
  const char *hit;
  if ((hit = strchr(plain, c))) { *usage = symbols[hit - plain]; return YES; }
  if ((hit = strchr(shifted, c))) { *usage = symbols[hit - shifted]; *shift = YES; return YES; }
  if ((hit = strchr(digitsShifted, c))) { long d = hit - digitsShifted; *usage = d == 0 ? 0x27 : 0x1E + (uint32_t)(d - 1); *shift = YES; return YES; }
  return NO;
}

// ---------------------------------------------------------------- capture and encoding

@interface Capture : NSObject
- (NSString *)start;
- (void)stop;
- (void)keyframe;
- (void)redo:(BOOL)key;
- (CVPixelBufferRef)copyLastFrame;
- (CGSize)pointSize;
@end

static Capture *gCapture;
static float gScale;

static NSDictionary *videoConfig(CMFormatDescriptionRef format) {
  CFDictionaryRef atoms = CMFormatDescriptionGetExtension(format, kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms);
  CFDataRef avcC = atoms ? CFDictionaryGetValue(atoms, CFSTR("avcC")) : NULL;
  if (!avcC || CFGetTypeID(avcC) != CFDataGetTypeID() || CFDataGetLength(avcC) < 4) return nil;
  const uint8_t *b = CFDataGetBytePtr(avcC);
  CMVideoDimensions size = CMVideoFormatDescriptionGetDimensions(format);
  return @{@"codec": [NSString stringWithFormat:@"avc1.%02X%02X%02X", b[1], b[2], b[3]], @"width": @(size.width), @"height": @(size.height),
           @"description": [(__bridge NSData *)avcC base64EncodedStringWithOptions:0]};
}

// VideoToolbox calls this serially per session, and a session is drained before the next one starts.
// frameRefcon is non-NULL for a forced keyframe.
static void encoded(void *sessionRefcon __unused, void *frameRefcon, OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sample) {
  static NSDictionary *lastConfig;
  static BOOL skipping;
  if (status != noErr) { fprintf(stderr, "sim-helper: encoder error %d\n", (int)status); return; }
  // Low-latency rate control drops frames now and then, forced keyframes included. On an
  // event-driven stream the dropped frame may be the last before the screen goes still.
  if (flags & kVTEncodeInfo_FrameDropped) { [gCapture redo:frameRefcon != NULL]; return; }
  if (!sample) return;
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
  BOOL key = !(attachments && CFArrayGetCount(attachments) &&
               CFDictionaryContainsKey(CFArrayGetValueAtIndex(attachments, 0), kCMSampleAttachmentKey_NotSync));
  // The app is not reading: drop frames, then resume with a keyframe once it has caught up.
  if (atomic_load(&gQueuedVideo) > kMaxQueuedVideo || (skipping && !key)) {
    skipping = YES;
    [gCapture redo:YES];
    return;
  }
  skipping = NO;
  if (key) {
    NSDictionary *config = videoConfig(CMSampleBufferGetFormatDescription(sample));
    if (!config) { fprintf(stderr, "sim-helper: keyframe without avcC\n"); return; }
    if (![config isEqualToDictionary:lastConfig]) { lastConfig = config; sendJSON(2, config); }
  }
  CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
  size_t length = CMBlockBufferGetDataLength(block);
  uint64_t timestamp = (uint64_t)CMTimeConvertScale(CMSampleBufferGetPresentationTimeStamp(sample), 1000000, kCMTimeRoundingMethod_Default).value;
  NSMutableData *data = frameStart(3);
  uint8_t keyByte = key;
  uint64_t timestampBE = CFSwapInt64HostToBig(timestamp);
  [data appendBytes:&keyByte length:1];
  [data appendBytes:&timestampBE length:8];
  size_t offset = data.length;
  [data increaseLengthBy:length];
  if (CMBlockBufferCopyDataBytes(block, 0, length, (uint8_t *)data.mutableBytes + offset) != kCMBlockBufferNoErr) return;
  frameSend(data, YES);
}

@implementation Capture {
  dispatch_queue_t _queue;
  NSMutableArray *_screens;
  NSMutableArray<NSUUID *> *_callbackIds;
  IOSurfaceRef _surface;  // -framebufferSurface is an XPC call (~3.7 ms): cached until surfacesChanged
  uint32_t _seed;
  VTCompressionSessionRef _session;
  CVPixelBufferPoolRef _pool;
  size_t _width, _height;
  CVPixelBufferRef _last;  // the latest copied frame, for screenshots
  BOOL _forceKey, _redo, _redoScheduled, _announced, _stopped;
}

- (NSString *)start {
  _queue = serialQueue("sim-helper.capture");
  _screens = [NSMutableArray new];
  _callbackIds = [NSMutableArray new];
  id io = [gDevice io];
  [io updateIOPorts];
  for (id port in [io deviceIOPorts]) {
    if (![port respondsToSelector:@selector(portIdentifier)] || ![port respondsToSelector:@selector(descriptor)]) continue;
    if (![[NSString stringWithFormat:@"%@", [port portIdentifier]] isEqualToString:@"com.apple.framebuffer.display"]) continue;
    id screen = [port descriptor];
    if ([screen respondsToSelector:@selector(framebufferSurface)]) [_screens addObject:screen];
  }
  if (!_screens.count) return @"The device has no screen to capture.";
  __weak Capture *weakSelf = self;
  for (id screen in _screens) {
    NSUUID *callbackId = [NSUUID UUID];
    [_callbackIds addObject:callbackId];
    [screen registerScreenCallbacksWithUUID:callbackId callbackQueue:_queue
      frameCallback:^{ [weakSelf frame:NO]; }
      surfacesChangedCallback:^{ [weakSelf frame:YES]; }
      propertiesChangedCallback:^{ [weakSelf frame:YES]; }];
  }
  return nil;
}

- (void)stop {
  dispatch_sync(_queue, ^{
    _stopped = YES;
    for (NSUInteger i = 0; i < _screens.count; i++) [_screens[i] unregisterScreenCallbacksWithUUID:_callbackIds[i]];
    [self closeSession];
  });
}

// Four framebuffer ports exist; one carries the live surface. Device Hub's 7680-wide one is skipped.
- (IOSurfaceRef)liveSurface {
  IOSurfaceRef best = NULL;
  size_t bestArea = 0;
  for (id screen in _screens) {
    IOSurfaceRef surface = [screen framebufferSurface];
    if (!surface || IOSurfaceGetWidth(surface) == 7680) continue;
    size_t area = IOSurfaceGetWidth(surface) * IOSurfaceGetHeight(surface);
    if (area > bestArea) { bestArea = area; best = surface; }
  }
  return best;
}

- (void)closeSession {
  if (_session) {
    VTCompressionSessionCompleteFrames(_session, kCMTimeInvalid);
    VTCompressionSessionInvalidate(_session);
    CFRelease(_session);
    _session = NULL;
  }
  if (_pool) { CVPixelBufferPoolRelease(_pool); _pool = NULL; }
}

- (BOOL)openSession:(size_t)width height:(size_t)height {
  [self closeSession];
  NSDictionary *spec = @{(__bridge NSString *)kVTVideoEncoderSpecification_EnableLowLatencyRateControl: @YES};
  VTCompressionSessionRef session = NULL;
  OSStatus status = VTCompressionSessionCreate(NULL, (int32_t)width, (int32_t)height, kCMVideoCodecType_H264, (__bridge CFDictionaryRef)spec,
                                               NULL, NULL, encoded, NULL, &session);
  if (status != noErr) { warn([NSString stringWithFormat:@"The H.264 encoder did not start (%d).", (int)status]); return NO; }
  // ReferenceBufferCount=1 gives an SPS with max_dec_frame_buffering=1: the decoder holds no frames.
  NSDictionary *properties = @{
    (__bridge NSString *)kVTCompressionPropertyKey_RealTime: @YES,
    (__bridge NSString *)kVTCompressionPropertyKey_AllowFrameReordering: @NO,
    (__bridge NSString *)kVTCompressionPropertyKey_ProfileLevel: (__bridge NSString *)kVTProfileLevel_H264_High_AutoLevel,
    (__bridge NSString *)kVTCompressionPropertyKey_AverageBitRate: @6000000,
    (__bridge NSString *)kVTCompressionPropertyKey_ExpectedFrameRate: @60,
    (__bridge NSString *)kVTCompressionPropertyKey_MaxKeyFrameInterval: @300,
    (__bridge NSString *)kVTCompressionPropertyKey_ReferenceBufferCount: @1,
  };
  for (NSString *key in properties) {
    OSStatus result = VTSessionSetProperty(session, (__bridge CFStringRef)key, (__bridge CFTypeRef)properties[key]);
    if (result != noErr) fprintf(stderr, "sim-helper: encoder refused %s (%d)\n", key.UTF8String, (int)result);
  }
  VTCompressionSessionPrepareToEncodeFrames(session);
  NSDictionary *attributes = @{(id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA), (id)kCVPixelBufferWidthKey: @(width),
                               (id)kCVPixelBufferHeightKey: @(height), (id)kCVPixelBufferIOSurfacePropertiesKey: @{}};
  if (CVPixelBufferPoolCreate(NULL, NULL, (__bridge CFDictionaryRef)attributes, &_pool) != kCVReturnSuccess) {
    VTCompressionSessionInvalidate(session);
    CFRelease(session);
    warn(@"The frame buffer pool could not be created.");
    return NO;
  }
  _session = session;
  _width = width;
  _height = height;
  return YES;
}

- (void)announce {
  NSDictionary *size = @{@"width": @(_width), @"height": @(_height), @"pointWidth": @(round(_width / gScale)), @"pointHeight": @(round(_height / gScale))};
  NSMutableDictionary *event = [size mutableCopy];
  event[@"event"] = _announced ? @"size" : @"ready";
  _announced = YES;
  emit(event);
}

- (void)frame:(BOOL)refresh {
  if (_stopped) return;
  if (refresh || !_surface) {
    if (_surface) CFRelease(_surface);
    _surface = [self liveSurface];
    if (_surface) CFRetain(_surface);
    refresh = YES;
  }
  if (!_surface) return;
  uint32_t seed = IOSurfaceGetSeed(_surface);
  if (!refresh && !_forceKey && !_redo && _last && seed == _seed) return;
  _seed = seed;
  _redo = NO;
  size_t width = IOSurfaceGetWidth(_surface), height = IOSurfaceGetHeight(_surface);
  if (!_session || width != _width || height != _height) {
    if (![self openSession:width height:height]) return;
    [self announce];
  }
  // SimulatorKit redraws the surface in place and VideoToolbox encodes asynchronously: copy first.
  CVPixelBufferRef frame = NULL;
  uint64_t captured = nowUs();
  if (CVPixelBufferPoolCreatePixelBuffer(NULL, _pool, &frame) != kCVReturnSuccess) { fprintf(stderr, "sim-helper: no pixel buffer\n"); return; }
  IOSurfaceLock(_surface, kIOSurfaceLockReadOnly, NULL);
  CVPixelBufferLockBaseAddress(frame, 0);
  const uint8_t *source = IOSurfaceGetBaseAddress(_surface);
  uint8_t *target = CVPixelBufferGetBaseAddress(frame);
  size_t sourceRow = IOSurfaceGetBytesPerRow(_surface), targetRow = CVPixelBufferGetBytesPerRow(frame);
  if (sourceRow == targetRow) memcpy(target, source, sourceRow * height);
  else for (size_t y = 0; y < height; y++) memcpy(target + y * targetRow, source + y * sourceRow, MIN(sourceRow, targetRow));
  CVPixelBufferUnlockBaseAddress(frame, 0);
  IOSurfaceUnlock(_surface, kIOSurfaceLockReadOnly, NULL);
  if (_last) CVPixelBufferRelease(_last);
  _last = frame;
  BOOL key = _forceKey;
  _forceKey = NO;
  NSDictionary *options = key ? @{(__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES} : nil;
  OSStatus status = VTCompressionSessionEncodeFrame(_session, frame, CMTimeMake((int64_t)captured, 1000000), kCMTimeInvalid,
                                                    (__bridge CFDictionaryRef)options, key ? (void *)1 : NULL, NULL);
  if (status != noErr) fprintf(stderr, "sim-helper: encode failed %d\n", (int)status);
}

// The screen may be static: encode it again rather than wait for the next change.
- (void)keyframe {
  dispatch_async(_queue, ^{
    _forceKey = YES;
    [self frame:NO];
  });
}

// Encode the screen again shortly, once however often it is asked for.
- (void)redo:(BOOL)key {
  dispatch_async(_queue, ^{
    if (key) _forceKey = YES;
    if (_redoScheduled) return;
    _redoScheduled = YES;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_MSEC), _queue, ^{
      _redoScheduled = NO;
      _redo = YES;
      [self frame:NO];
    });
  });
}

- (CVPixelBufferRef)copyLastFrame {
  __block CVPixelBufferRef frame = NULL;
  dispatch_sync(_queue, ^{ frame = _last ? CVPixelBufferRetain(_last) : NULL; });
  return frame;
}

- (CGSize)pointSize {
  __block CGSize size = CGSizeZero;
  dispatch_sync(_queue, ^{ size = CGSizeMake(round(_width / gScale), round(_height / gScale)); });
  return size;
}
@end

// ---------------------------------------------------------------- screenshot

// The frame keeps the device's portrait pixels with the content turned; a screenshot stands like the interface.
static CGImagePropertyOrientation screenshotOrientation(id name) {
  if ([name isEqual:@"landscapeLeft"]) return kCGImagePropertyOrientationLeft;
  if ([name isEqual:@"landscapeRight"]) return kCGImagePropertyOrientationRight;
  if ([name isEqual:@"portraitUpsideDown"]) return kCGImagePropertyOrientationDown;
  return kCGImagePropertyOrientationUp;
}

static NSDictionary *screenshot(double maxSide, CGImagePropertyOrientation orientation, NSString **error) {
  CVPixelBufferRef frame = [gCapture copyLastFrame];
  if (!frame) { *error = @"No frame has arrived from the device yet."; return nil; }
  static CIContext *context;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ context = [CIContext contextWithOptions:nil]; });
  CIImage *image = [[CIImage imageWithCVPixelBuffer:frame] imageByApplyingCGOrientation:orientation];
  CVPixelBufferRelease(frame);
  double scale = MIN(1.0, maxSide / MAX(image.extent.size.width, image.extent.size.height));
  if (scale < 1) image = [image imageByApplyingFilter:@"CILanczosScaleTransform" withInputParameters:@{kCIInputScaleKey: @(scale), kCIInputAspectRatioKey: @1}];
  CGRect extent = CGRectIntegral(image.extent);
  image = [image imageByCroppingToRect:extent];
  CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  NSData *jpeg = [context JPEGRepresentationOfImage:image colorSpace:space options:@{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @0.8}];
  CGColorSpaceRelease(space);
  if (!jpeg) { *error = @"The screenshot could not be encoded."; return nil; }
  return @{@"jpeg": [jpeg base64EncodedStringWithOptions:0], @"width": @(extent.size.width), @"height": @(extent.size.height)};
}

// ---------------------------------------------------------------- accessibility (AXPTranslator)

// The translator asks this delegate to carry each request to the device and waits for the answer.
@interface AXBridge : NSObject
@end

static dispatch_queue_t gAX;        // ui requests, one at a time
static dispatch_queue_t gAXReplies; // device answers; the translator blocks gAX while it waits
static dispatch_time_t gAXDeadline; // gAX only: a device that stops answering fails the request, not every attribute
static BOOL gAXTimedOut;

@implementation AXBridge
- (id)accessibilityTranslationDelegateBridgeCallbackWithToken:(NSString *)token {
  return ^id(id request) {
    Class response = NSClassFromString(@"AXPTranslatorResponse");
    if (!request || gAXTimedOut) return [(id<SimPrivate>)response emptyResponse];
    __block id result = nil;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [gDevice sendAccessibilityRequestAsync:request completionQueue:gAXReplies completionHandler:^(id answer) {
      result = answer;
      dispatch_semaphore_signal(done);
    }];
    if (dispatch_semaphore_wait(done, gAXDeadline)) { gAXTimedOut = YES; return [(id<SimPrivate>)response emptyResponse]; }
    return result ?: [(id<SimPrivate>)response emptyResponse];
  };
}
- (CGRect)accessibilityTranslationConvertPlatformFrameToSystem:(CGRect)rect withToken:(NSString *)token { return rect; }
- (id)accessibilityTranslationRootParentWithToken:(NSString *)token { return nil; }
@end

static id gTranslator;
static AXBridge *gAXBridge;
static NSString *gAXToken;  // gAX only; new per request, or the translator answers with a cached frontmost app

static NSString *axSetup(void) {
  if (gTranslator) return nil;
  if (!dlopen("/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/AccessibilityPlatformTranslation", RTLD_NOW))
    return @"The accessibility translator is missing on this Mac.";
  Class translator = NSClassFromString(@"AXPTranslator");
  if (!translator) return @"The accessibility translator is not supported on this Mac.";
  gAXBridge = [AXBridge new];
  gTranslator = [(id<SimPrivate>)translator sharedInstance];
  [gTranslator setValue:gAXBridge forKey:@"bridgeTokenDelegate"];
  [gTranslator setValue:@YES forKey:@"supportsDelegateTokens"];
  [gTranslator setValue:@YES forKey:@"accessibilityEnabled"];
  return nil;
}

static NSString *axString(id element, NSString *key) {
  id value = nil;
  @try { value = [element valueForKey:key]; } @catch (NSException *e) { return nil; }
  if ([value isKindOfClass:NSAttributedString.class]) value = [value string];
  if (value && ![value isKindOfClass:NSString.class]) value = [value description];
  return [value length] ? value : nil;
}

static double points(double v) { return isfinite(v) ? round(v) : 0; }

// Elements need the token on their translation before any attribute read.
static NSDictionary *axElement(id element) {
  @try { [[element valueForKey:@"translation"] setValue:gAXToken forKey:@"bridgeDelegateToken"]; } @catch (NSException *e) {}
  NSRect frame = [element respondsToSelector:@selector(accessibilityFrame)] ? [(NSAccessibilityElement *)element accessibilityFrame] : NSZeroRect;
  NSString *role = axString(element, @"accessibilityRole") ?: @"Unknown";
  if ([role hasPrefix:@"AX"]) role = [role substringFromIndex:2];
  NSMutableDictionary *out = [@{@"role": role, @"frame": @[@(points(frame.origin.x)), @(points(frame.origin.y)), @(points(frame.size.width)), @(points(frame.size.height))]} mutableCopy];
  NSString *label = axString(element, @"accessibilityLabel"), *identifier = axString(element, @"accessibilityIdentifier"), *value = axString(element, @"accessibilityValue");
  if (label) out[@"label"] = label;
  if (identifier) out[@"id"] = identifier;
  if (value) out[@"value"] = value;
  return out;
}

static void axWalk(id element, int depth, NSMutableArray *out) {
  if (out.count >= 600 || depth > 60) return;
  [out addObject:axElement(element)];
  NSArray *children = nil;
  @try { children = [element accessibilityChildren]; } @catch (NSException *e) {}
  for (id child in children) axWalk(child, depth + 1, out);
}

static NSDictionary *axTree(BOOL grid, NSString **error) {
  if ((*error = axSetup())) return nil;
  // For some 20 s after boot the guest's accessibility server answers with no application.
  id translation = nil;
  for (uint64_t giveUp = nowUs() + 25000000; !translation; sleepFor(0.5)) {
    gAXToken = NSUUID.UUID.UUIDString;
    gAXDeadline = dispatch_time(DISPATCH_TIME_NOW, (grid ? 20 : 8) * NSEC_PER_SEC);
    gAXTimedOut = NO;
    translation = [gTranslator frontmostApplicationWithDisplayId:0 bridgeDelegateToken:gAXToken];
    if (!translation && (nowUs() > giveUp || !deviceBooted())) { *error = @"The device did not describe its screen."; return nil; }
  }
  [translation setValue:gAXToken forKey:@"bridgeDelegateToken"];
  id root = [gTranslator macPlatformElementFromTranslation:translation];
  if (!root) { *error = @"The device did not describe its screen."; return nil; }
  NSMutableArray *elements = [NSMutableArray new];
  axWalk(root, 0, elements);
  CGSize screen = [gCapture pointSize];
  // Containers often hide children from the walk; a 32 pt hit-test grid finds them (1.5–4 s).
  if (grid && screen.width > 0) {
    NSMutableSet *seen = [NSMutableSet new];
    for (NSDictionary *e in elements) [seen addObject:@[e[@"role"], e[@"frame"], e[@"label"] ?: @""]];
    for (CGFloat y = 16; y < screen.height; y += 32)
      for (CGFloat x = 16; x < screen.width; x += 32) {
        id hit = [gTranslator objectAtPoint:CGPointMake(x, y) displayId:0 bridgeDelegateToken:gAXToken];
        if (!hit) continue;
        [hit setValue:gAXToken forKey:@"bridgeDelegateToken"];
        id element = [gTranslator macPlatformElementFromTranslation:hit];
        if (!element) continue;
        NSDictionary *e = axElement(element);
        NSArray *key = @[e[@"role"], e[@"frame"], e[@"label"] ?: @""];
        if ([seen containsObject:key]) continue;
        [seen addObject:key];
        [elements addObject:e];
      }
  }
  if (gAXTimedOut) { *error = @"The device did not describe its screen in time."; return nil; }
  return @{@"width": @(screen.width), @"height": @(screen.height), @"elements": elements};
}

// ---------------------------------------------------------------- commands

static void quit(int code) {
  // Exit within a second even if a queue is stuck in a device call.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 900 * NSEC_PER_MSEC), dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ _exit(code); });
  [gCapture stop];
  dispatch_sync(gOut, ^{});
  exit(code);
}

static BOOL coordinate(NSDictionary *m, NSString *key, double *out) {
  id v = m[key];
  if (![v isKindOfClass:NSNumber.class] || !isfinite([v doubleValue])) return NO;
  *out = MIN(1.0, MAX(0.0, [v doubleValue]));
  return YES;
}

static double seconds(NSDictionary *m, double fallback) {
  id v = m[@"duration"];
  double s = [v isKindOfClass:NSNumber.class] && isfinite([v doubleValue]) ? [v doubleValue] : fallback;
  return MIN(10.0, MAX(0.05, s));
}

// Runs `body` on the input queue once input is connected; replies when it has left for the device.
static void withInput(NSNumber *requestId, NSString *(^body)(void)) {
  dispatch_async(gInput, ^{
    NSString *error = inputReady();
    if (!error) error = body();
    if (requestId && !error) inputFlush();
    if (requestId || error) reply(requestId, nil, error);
  });
}

static void handle(NSDictionary *m) {
  NSNumber *requestId = [m[@"id"] isKindOfClass:NSNumber.class] ? m[@"id"] : nil;
  NSString *cmd = [m[@"cmd"] isKindOfClass:NSString.class] ? m[@"cmd"] : @"";
  double x, y, x2, y2;

  if ([cmd isEqualToString:@"touch"]) {
    NSDictionary *phases = @{@"down": @(PhaseDown), @"move": @(PhasePosition), @"up": @(PhaseUp)};
    NSNumber *phase = [m[@"phase"] isKindOfClass:NSString.class] ? phases[m[@"phase"]] : nil;
    if (!phase || !coordinate(m, @"x", &x) || !coordinate(m, @"y", &y)) { reply(requestId, nil, @"A touch needs a phase and x, y from 0 to 1."); return; }
    withInput(requestId, ^NSString * { sendTouch(x, y, (Phase)phase.intValue); return nil; });
  } else if ([cmd isEqualToString:@"tap"]) {
    if (!coordinate(m, @"x", &x) || !coordinate(m, @"y", &y)) { reply(requestId, nil, @"A tap needs x and y from 0 to 1."); return; }
    withInput(requestId, ^NSString * { sendTouch(x, y, PhaseDown); sleepFor(0.06); sendTouch(x, y, PhaseUp); return nil; });
  } else if ([cmd isEqualToString:@"longpress"]) {
    if (!coordinate(m, @"x", &x) || !coordinate(m, @"y", &y)) { reply(requestId, nil, @"A long press needs x and y from 0 to 1."); return; }
    double duration = seconds(m, 0.8);
    withInput(requestId, ^NSString * { sendTouch(x, y, PhaseDown); sleepFor(duration); sendTouch(x, y, PhaseUp); return nil; });
  } else if ([cmd isEqualToString:@"swipe"]) {
    if (!coordinate(m, @"x1", &x) || !coordinate(m, @"y1", &y) || !coordinate(m, @"x2", &x2) || !coordinate(m, @"y2", &y2))
      { reply(requestId, nil, @"A swipe needs x1, y1, x2, y2 from 0 to 1."); return; }
    double duration = seconds(m, 0.3);
    withInput(requestId, ^NSString * { gesture(x, y, x2, y2, duration); return nil; });
  } else if ([cmd isEqualToString:@"button"]) {
    NSString *name = m[@"name"];
    BOOL home = [name isEqual:@"home"];
    if (!home && ![name isEqual:@"lock"]) { reply(requestId, nil, @"The button must be home or lock."); return; }
    withInput(requestId, ^NSString * {
      sendButton(home ? 0x40 : 0x30, home ? 0x0 : 0x1, YES);
      sleepFor(0.1);
      sendButton(home ? 0x40 : 0x30, home ? 0x0 : 0x1, NO);
      return nil;
    });
  } else if ([cmd isEqualToString:@"key"]) {
    id usage = m[@"usage"];
    if (![usage isKindOfClass:NSNumber.class] || [usage intValue] <= 0 || [usage intValue] > 0xFFFF) { reply(requestId, nil, @"A key needs a HID usage."); return; }
    BOOL down = [m[@"down"] boolValue];
    uint32_t code = [usage unsignedIntValue];
    withInput(requestId, ^NSString * { sendKey(code, down); return nil; });
  } else if ([cmd isEqualToString:@"text"]) {
    NSString *text = [m[@"text"] isKindOfClass:NSString.class] ? m[@"text"] : nil;
    if (!text) { reply(requestId, nil, @"Text is missing."); return; }
    NSMutableData *keys = [NSMutableData new];  // pairs of (usage, shift)
    for (NSUInteger i = 0; i < text.length; i++) {
      uint32_t pair[2];
      BOOL shift;
      if (!usageForCharacter([text characterAtIndex:i], &pair[0], &shift)) { reply(requestId, nil, @"Only ASCII text can be typed; paste the rest."); return; }
      pair[1] = shift;
      [keys appendBytes:pair length:sizeof pair];
    }
    withInput(requestId, ^NSString * {
      const uint32_t *pairs = keys.bytes;
      for (NSUInteger i = 0; i < keys.length / sizeof(uint32_t[2]); i++) {
        uint32_t usage = pairs[i * 2], shift = pairs[i * 2 + 1];
        if (shift) sendKey(0xE1, YES);
        sendKey(usage, YES);
        sleepFor(0.015);
        sendKey(usage, NO);
        if (shift) sendKey(0xE1, NO);
        sleepFor(0.015);
      }
      return nil;
    });
  } else if ([cmd isEqualToString:@"keyframe"]) {
    [gCapture keyframe];
    if (requestId) reply(requestId, nil, nil);
  } else if ([cmd isEqualToString:@"ui"]) {
    BOOL grid = [m[@"grid"] boolValue];
    dispatch_async(gAX, ^{
      NSString *error = nil;
      NSDictionary *tree = axTree(grid, &error);
      reply(requestId, tree, error);
    });
  } else if ([cmd isEqualToString:@"screenshot"]) {
    id side = m[@"maxSide"];
    double maxSide = [side isKindOfClass:NSNumber.class] && [side doubleValue] >= 16 ? [side doubleValue] : 1000;
    CGImagePropertyOrientation orientation = screenshotOrientation(m[@"orientation"]);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSString *error = nil;
      NSDictionary *shot = screenshot(maxSide, orientation, &error);
      reply(requestId, shot, error);
    });
  } else if ([cmd isEqualToString:@"quit"]) {
    quit(0);
  } else {
    reply(requestId, nil, [NSString stringWithFormat:@"Unknown command \"%@\".", cmd]);
  }
}

static void readCommands(void) {
  static NSMutableData *pending;
  static dispatch_source_t source;  // a released source stops firing
  pending = [NSMutableData new];
  source = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
  dispatch_source_set_event_handler(source, ^{
    @autoreleasepool {
      uint8_t buffer[65536];
      ssize_t n = read(STDIN_FILENO, buffer, sizeof buffer);
      if (n < 0 && (errno == EINTR || errno == EAGAIN)) return;
      if (n <= 0) quit(0);  // the app keeps stdin open: EOF means it is gone, even after a SIGKILL
      [pending appendBytes:buffer length:(NSUInteger)n];
      const uint8_t *bytes = pending.bytes;
      NSUInteger start = 0;
      for (NSUInteger i = 0; i < pending.length; i++) {
        if (bytes[i] != '\n') continue;
        NSData *line = [pending subdataWithRange:NSMakeRange(start, i - start)];
        start = i + 1;
        if (!line.length) continue;
        id message = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
        if ([message isKindOfClass:NSDictionary.class]) handle(message);
        else warn(@"A command was not a JSON object.");
      }
      [pending replaceBytesInRange:NSMakeRange(0, start) withBytes:NULL length:0];
    }
  });
  dispatch_resume(source);
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_IGN);
    gOut = serialQueue("sim-helper.out");
    NSString *udid = nil;
    for (int i = 1; i + 1 < argc; i++)
      if (!strcmp(argv[i], "--udid")) udid = @(argv[i + 1]);
    if (!udid) fail(@"Usage: sim-helper --udid <UDID>.");
    NSString *error = openDevice(udid);
    if (error) fail(error);
    gScale = [[gDevice deviceType] mainScreenScale];
    if (gScale <= 0) gScale = 1;

    gInput = serialQueue("sim-helper.input");
    gInputIO = serialQueue("sim-helper.input-io");
    gIndigoPending = dispatch_group_create();
    NSString *version = [NSBundle bundleForClass:NSClassFromString(@"SimDevice")].infoDictionary[@"CFBundleVersion"];
    gIndigo = [version compare:@"1155.4" options:NSNumericSearch] == NSOrderedAscending;
    gAX = serialQueue("sim-helper.ax");
    gAXReplies = serialQueue("sim-helper.ax-replies");

    gCapture = [Capture new];
    if ((error = [gCapture start])) fail(error);
    // Connect input now so the first touch does not wait for the ~200 ms liveness barrier.
    dispatch_async(gInput, ^{ NSString *e = inputReady(); if (e) warn(e); });
    readCommands();

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
      if (CGSizeEqualToSize([gCapture pointSize], CGSizeZero)) fail(@"The device screen did not appear.");
    });
    dispatch_source_t watch = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(watch, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, 100 * NSEC_PER_MSEC);
    dispatch_source_set_event_handler(watch, ^{ if (!deviceBooted()) fail(@"The device stopped running."); });
    dispatch_resume(watch);
    CFRunLoopRun();
  }
  return 0;
}
