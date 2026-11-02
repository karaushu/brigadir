#include <unistd.h>
#import <AppKit/AppKit.h>
#import <CoreText/CoreText.h>
#include <stdio.h>

static void publish(void) {
  @autoreleasepool {
    NSMutableArray *fonts = [NSMutableArray array];
    NSFontManager *manager = NSFontManager.sharedFontManager;
    for (NSString *family in [manager.availableFontFamilies sortedArrayUsingSelector:@selector(localizedCaseInsensitiveCompare:)]) {
      if ([family hasPrefix:@"."]) continue;
      NSFont *font = [manager fontWithFamily:family traits:0 weight:5 size:13];
      if (!font) continue;
      // spec/appearance#interface-font: every family goes out; `mono` keeps the code surfaces to fixed-pitch ones, the interface may use any.
      BOOL mono = font.isFixedPitch || ([manager traitsOfFont:font] & NSFixedPitchFontMask);
      const UniChar characters[] = {0x2500,0x2502,0x2514,0x2518,0x251c};
      CGGlyph glyphs[5];
      BOOL coverage = CTFontGetGlyphsForCharacters((__bridge CTFontRef)font, characters, glyphs, 5);
      [fonts addObject:@{@"family":family,@"mono":@(mono),@"boxDrawing":@(coverage)}];
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"fonts":fonts} options:0 error:nil];
    if (data) { fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout); }
  }
}
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    publish();
    if (argc>1 && strcmp(argv[1], "--watch")==0) {
      id observer = [NSDistributedNotificationCenter.defaultCenter addObserverForName:(__bridge NSString *)kCTFontManagerRegisteredFontsChangedNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note){ publish(); }];
      // The app keeps our stdin open and never writes to it: EOF means it is gone, even after a SIGKILL.
      dispatch_source_t parent = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
      dispatch_source_set_event_handler(parent, ^{ char byte; if (read(STDIN_FILENO, &byte, 1) <= 0) exit(0); });
      dispatch_resume(parent);
      [NSRunLoop.currentRunLoop run];
      [NSDistributedNotificationCenter.defaultCenter removeObserver:observer];
    }
  }
  return 0;
}
