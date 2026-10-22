#import "NIIMBOTSDKAdapter.h"
#import <TargetConditionals.h>
#import <UIKit/UIKit.h>
#import <math.h>
#if !TARGET_OS_SIMULATOR
#import "Vendor/NIIMBOT/JCAPI.h"
#endif

@interface NIIMBOTSDKAdapter ()
@property(nonatomic) NSUInteger connectionGeneration;
@property(nonatomic, readwrite) BOOL errorListenerReady;
@property(nonatomic, copy, nullable) NSString *preferredImageEncoding;
@property(nonatomic, strong) NSMutableArray<NSString *> *imageEncodingAttempts;
@property(nonatomic, copy, nullable) void (^pendingBitmapCompletion)(BOOL completed);
@property(nonatomic) NSUInteger bitmapGeneration;
- (BOOL)drawImage:(NSString *)base64 x:(float)x y:(float)y width:(float)w height:(float)h;
- (NSArray<NSDictionary<NSString *, id> *> *)imageCandidates:(NSString *)base64;
- (void)finishPendingBitmapForGeneration:(NSUInteger)generation;
- (void)failPendingBitmapForGeneration:(NSUInteger)generation;
@end

#if !TARGET_OS_SIMULATOR
/// JCAPI's bitmap channel needs composited ARGB bytes. The SDK demo builds
/// PremultipliedFirst buffers; callers choose the byte order it produces.
static NSData *NIIMBOTBitmapBytes(UIImage *image, BOOL alphaFirst) {
    CGImageRef cgImage = image.CGImage;
    if (!cgImage) return nil;
    size_t width = CGImageGetWidth(cgImage), height = CGImageGetHeight(cgImage);
    if (!width || !height) return nil;
    size_t rowBytes = width * 4;
    NSMutableData *buffer = [NSMutableData dataWithLength:rowBytes * height];
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    if (!space) return nil;
    CGBitmapInfo info = (CGBitmapInfo)(alphaFirst ? kCGImageAlphaPremultipliedFirst : kCGImageAlphaPremultipliedLast);
    CGContextRef context = CGBitmapContextCreate(buffer.mutableBytes, width, height, 8, rowBytes, space, info);
    CGColorSpaceRelease(space);
    if (!context) return nil;
    CGContextSetFillColorWithColor(context, UIColor.whiteColor.CGColor);
    CGContextFillRect(context, CGRectMake(0, 0, width, height));
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), cgImage);
    CGContextRelease(context);
    return buffer;
}

static NSString *NIIMBOTBitmapPNG(UIImage *image, BOOL alphaFirst) {
    NSMutableData *bytes = (NSMutableData *)NIIMBOTBitmapBytes(image, alphaFirst);
    if (!bytes) return nil;
    size_t width = CGImageGetWidth(image.CGImage), height = CGImageGetHeight(image.CGImage);
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    if (!space) return nil;
    CGBitmapInfo info = (CGBitmapInfo)(alphaFirst ? kCGImageAlphaPremultipliedFirst : kCGImageAlphaPremultipliedLast);
    CGContextRef context = CGBitmapContextCreate(bytes.mutableBytes, width, height, 8, width * 4, space, info);
    CGColorSpaceRelease(space);
    if (!context) return nil;
    CGImageRef rendered = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    if (!rendered) return nil;
    NSData *png = UIImagePNGRepresentation([UIImage imageWithCGImage:rendered]);
    CGImageRelease(rendered);
    return png ? [png base64EncodedStringWithOptions:0] : nil;
}

@implementation NIIMBOTSDKAdapter (ImageDrawing)

- (BOOL)drawImage:(NSString *)base64 x:(float)x y:(float)y width:(float)w height:(float)h {
    NSArray<NSDictionary<NSString *, id> *> *candidates = [self imageCandidates:base64];
    for (NSDictionary *candidate in candidates) {
        NSString *data = candidate[@"data"];
        if (data.length == 0) continue;
        if ([JCAPI DrawLableImage:x withY:y withWidth:w withHeight:h withImageData:data withRotate:0
            withImageProcessingType:1 withImageProcessingValue:127]) {
            self.preferredImageEncoding = candidate[@"name"];
            return YES;
        }
        [self.imageEncodingAttempts addObject:candidate[@"name"]];
    }
    return NO;
}

- (NSArray<NSDictionary<NSString *, id> *> *)imageCandidates:(NSString *)base64 {
    NSMutableArray<NSDictionary<NSString *, id> *> *candidates = [NSMutableArray array];
    NSMutableSet<NSString *> *seen = [NSMutableSet set];
    void (^add)(NSString *, NSString *) = ^(NSString *name, NSString *data) {
        if (data.length == 0 || [seen containsObject:data]) return;
        [seen addObject:data];
        [candidates addObject:@{@"name": name, @"data": data}];
    };
    UIImage *image = [UIImage imageWithData:[[NSData alloc] initWithBase64EncodedString:base64 options:0]];
    NSString *preferred = self.preferredImageEncoding;
    if ([preferred isEqualToString:@"png-rgba"]) add(preferred, NIIMBOTBitmapPNG(image, NO));
    else if ([preferred isEqualToString:@"png-argb"]) add(preferred, NIIMBOTBitmapPNG(image, YES));
    else if ([preferred isEqualToString:@"jpeg"]) {
        NSData *jpeg = image ? UIImageJPEGRepresentation(image, 0.95) : nil;
        add(preferred, jpeg ? [jpeg base64EncodedStringWithOptions:0] : nil);
    } else if ([preferred isEqualToString:@"raw-rgba"]) {
        NSData *raw = image ? NIIMBOTBitmapBytes(image, NO) : nil;
        add(preferred, raw ? [raw base64EncodedStringWithOptions:0] : nil);
    } else if ([preferred isEqualToString:@"raw-argb"]) {
        NSData *raw = image ? NIIMBOTBitmapBytes(image, YES) : nil;
        add(preferred, raw ? [raw base64EncodedStringWithOptions:0] : nil);
    } else if (preferred.length > 0) {
        add(preferred, base64);
    }
    add(@"png", base64);
    if (image) {
        add(@"png-rgba", NIIMBOTBitmapPNG(image, NO));
        add(@"png-argb", NIIMBOTBitmapPNG(image, YES));
        NSData *jpeg = UIImageJPEGRepresentation(image, 0.95);
        if (jpeg) add(@"jpeg", [jpeg base64EncodedStringWithOptions:0]);
        NSData *rgba = NIIMBOTBitmapBytes(image, NO);
        if (rgba) add(@"raw-rgba", [rgba base64EncodedStringWithOptions:0]);
        NSData *argb = NIIMBOTBitmapBytes(image, YES);
        if (argb) add(@"raw-argb", [argb base64EncodedStringWithOptions:0]);
    }
    return candidates;
}

@end

#endif

@implementation NIIMBOTSDKAdapter

+ (instancetype)sharedAdapter {
    static NIIMBOTSDKAdapter *adapter;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ adapter = [[NIIMBOTSDKAdapter alloc] init]; });
    return adapter;
}

- (BOOL)supported {
#if TARGET_OS_SIMULATOR
    return NO;
#else
    return YES;
#endif
}

- (BOOL)connected {
#if TARGET_OS_SIMULATOR
    return NO;
#else
    return [JCAPI isConnectingState] == 1;
#endif
}

- (NSString *)connectedPrinterName {
#if TARGET_OS_SIMULATOR
    return nil;
#else
    return self.connected ? [JCAPI connectingPrinterName] : nil;
#endif
}

- (void)scan:(void (^)(NSArray<NSString *> *))completion {
    NSAssert(NSThread.isMainThread, @"The label SDK owner must run on the main queue");
#if TARGET_OS_SIMULATOR
    completion(@[]);
#else
    [JCAPI scanBluetoothPrinter:^(NSArray *names) {
        NSMutableArray<NSString *> *validNames = [NSMutableArray array];
        for (id name in names) {
            if ([name isKindOfClass:NSString.class] && [(NSString *)name length] > 0) [validNames addObject:name];
        }
        dispatch_async(dispatch_get_main_queue(), ^{ completion(validNames); });
    }];
#endif
}

- (void)connectPrinter:(NSString *)printerName completion:(void (^)(BOOL))completion {
    NSAssert(NSThread.isMainThread, @"The label SDK owner must run on the main queue");
#if TARGET_OS_SIMULATOR
    completion(NO);
#else
    self.errorListenerReady = NO;
    NSUInteger generation = ++self.connectionGeneration;
    __weak typeof(self) weakSelf = self;
    __block BOOL resolved = NO;
    [JCAPI openPrinter:printerName completion:^(BOOL accepted) {
        dispatch_async(dispatch_get_main_queue(), ^{
            typeof(self) owner = weakSelf;
            if (!owner || owner.connectionGeneration != generation) return;
            BOOL connected = accepted && [JCAPI isConnectingState] == 1
                && [[JCAPI connectingPrinterName] isEqualToString:printerName];
            if (connected) [owner installListenersForGeneration:generation];
            else owner.errorListenerReady = NO;
            if (!resolved) { resolved = YES; completion(connected); }
            if (owner.connectionChanged) owner.connectionChanged(connected);
        });
    }];
#endif
}

#if !TARGET_OS_SIMULATOR
- (void)installListenersForGeneration:(NSUInteger)generation {
    __weak typeof(self) weakSelf = self;
    // Register errors before any task configuration, and register again after reconnect.
    [JCAPI getPrintingErrorInfo:^(NSString *rawCode) {
        dispatch_async(dispatch_get_main_queue(), ^{
            typeof(self) owner = weakSelf;
            if (owner && owner.connectionGeneration == generation && owner.printingError) {
                // Preserve unknown codes without exposing SDK payloads as log messages.
                NSString *code = [rawCode isKindOfClass:NSString.class] ? rawCode : @"UNKNOWN";
                if (code.length > 32) code = @"UNKNOWN";
                owner.printingError(code);
            }
        });
    }];
    self.errorListenerReady = YES;
    // The SDK documents this count as device-specific and possibly lossy. Keep
    // it as diagnostics only; waiting for it leaves K3 jobs stuck forever.
    [JCAPI getPrintingCountInfo:^(NSDictionary *counts) {
        dispatch_async(dispatch_get_main_queue(), ^{
            typeof(self) owner = weakSelf;
            if (owner && owner.connectionGeneration == generation && owner.diagnosticCount) {
                NSMutableDictionary *safe = [NSMutableDictionary dictionary];
                for (NSString *key in @[@"totalCount", @"pageCount", @"pageNO"]) {
                    id value = counts[key];
                    if ([value isKindOfClass:NSNumber.class]) safe[key] = value;
                    else if ([value isKindOfClass:NSString.class] && [value length] < 16) safe[key] = value;
                }
                owner.diagnosticCount(safe);
            }
        });
    }];
}
#endif

- (void)disconnect {
    NSAssert(NSThread.isMainThread, @"The label SDK owner must run on the main queue");
    ++self.connectionGeneration;
    self.errorListenerReady = NO;
    [self failPendingBitmapForGeneration:self.bitmapGeneration];
#if !TARGET_OS_SIMULATOR
    [JCAPI closePrinter];
#endif
}

- (NSDictionary *)renderWidth:(double)width height:(double)height elements:(NSArray<NSDictionary *> *)elements {
    NSAssert(NSThread.isMainThread, @"The label SDK owner must run on the main queue");
#if TARGET_OS_SIMULATOR
    return @{@"errorCode": @"UNSUPPORTED_PLATFORM", @"message": @"官方标签预览仅支持 iOS 真机"};
#else
    @try {
        NSError *error = nil;
        // Official documentation permits no custom font directory. The demo passes
        // nil for system fonts; an empty path can leave the image pipeline unusable.
        [JCAPI initImageProcessing:nil error:&error];
        if (error) return @{@"errorCode": @"FONT_INITIALIZATION_FAILED", @"message": @"官方绘图库字体初始化失败"};
        [JCAPI initDrawingBoard:(float)width withHeight:(float)height withHorizontalShift:0
             withVerticalShift:0 rotate:0 fontArray:@[]];
        self.imageEncodingAttempts = [NSMutableArray array];
        NSUInteger index = 0;
        for (NSDictionary *element in elements) {
            float x = [element[@"x"] floatValue], y = [element[@"y"] floatValue];
            float w = [element[@"w"] floatValue], h = [element[@"h"] floatValue];
            NSString *type = element[@"type"];
            NSString *field = [element[@"sourceField"] isKindOfClass:NSString.class] ? element[@"sourceField"] : type;
            if (![type isKindOfClass:NSString.class] || !(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= width + 0.01 && y + h <= height + 0.01)) {
                return @{@"errorCode": @"DRAWING_ELEMENT_INVALID",
                         @"message": [NSString stringWithFormat:@"官方 SDK 元素 %lu（%@）坐标或尺寸无效", (unsigned long)index + 1, field ?: @"未知"]};
            }
            BOOL drawn = NO;
            if ([type isEqualToString:@"image"]) {
                // CoreText already shaped and measured this opaque black-on-white PNG.
                NSString *data = [element[@"imageBase64"] isKindOfClass:NSString.class] ? element[@"imageBase64"] : @"";
                if (data.length == 0) return @{@"errorCode": @"DRAWING_IMAGE_DATA_MISSING",
                    @"message": [NSString stringWithFormat:@"官方 SDK 图片元素 %lu（%@）缺少 PNG 数据", (unsigned long)index + 1, field ?: @"图片"]};
                drawn = [self drawImage:data x:x y:y width:w height:h];
                if (!drawn && ![element[@"optional"] boolValue]) {
                    return @{@"errorCode": @"DRAWING_IMAGE_REJECTED",
                        @"message": [NSString stringWithFormat:@"官方 SDK 拒绝图片元素 %lu（%@，%.2f × %.2f mm；已尝试 %@）", (unsigned long)index + 1, field ?: @"图片", w, h,
                            [self.imageEncodingAttempts componentsJoinedByString:@","]]};
                }
            } else if ([type isEqualToString:@"qr"]) {
                NSString *text = [element[@"text"] isKindOfClass:NSString.class] ? element[@"text"] : @"";
                if (text.length == 0) return @{@"errorCode": @"DRAWING_QR_DATA_MISSING",
                    @"message": [NSString stringWithFormat:@"官方 SDK 二维码元素 %lu 缺少内容", (unsigned long)index + 1]};
                drawn = [JCAPI drawLableQrCode:x withY:y withWidth:w withHeight:h withString:text withRotate:0 withCodeType:31];
                if (!drawn) return @{@"errorCode": @"DRAWING_QR_REJECTED",
                    @"message": [NSString stringWithFormat:@"官方 SDK 拒绝二维码元素 %lu（%.2f × %.2f mm）", (unsigned long)index + 1, w, h]};
            } else if ([type isEqualToString:@"line"]) {
                drawn = [JCAPI DrawLableLine:x withY:y withWidth:w withHeight:h withRotate:0 withLineType:1 withDashWidth:@[@1, @1]];
                if (!drawn) return @{@"errorCode": @"DRAWING_LINE_REJECTED",
                    @"message": [NSString stringWithFormat:@"官方 SDK 拒绝线条元素 %lu（%.2f × %.2f mm）", (unsigned long)index + 1, w, h]};
            } else {
                return @{@"errorCode": @"DRAWING_ELEMENT_UNSUPPORTED",
                    @"message": [NSString stringWithFormat:@"官方 SDK 不支持的绘制元素 %@", type]};
            }
            index += 1;
        }
        NSString *json = [JCAPI GenerateLableJson];
        if (json.length == 0) return @{@"errorCode": @"SDK_JSON_EMPTY", @"message": @"官方 SDK 未生成标签数据"};
        UIImage *preview = [JCAPI generateImagePreviewImage:3 error:&error];
        NSData *png = preview ? UIImagePNGRepresentation(preview) : nil;
        if (error || !png || png.length == 0) return @{@"errorCode": @"PREVIEW_FAILED", @"message": @"官方 SDK 未生成有效预览"};
        return @{@"sdkJson": json, @"imageBase64": [png base64EncodedStringWithOptions:0]};
    } @catch (NSException *exception) {
        NSString *reason = exception.reason ?: @"未知异常";
        if (reason.length > 120) reason = [reason substringToIndex:120];
        return @{@"errorCode": @"SDK_RENDER_EXCEPTION", @"message": [NSString stringWithFormat:@"官方绘图库异常：%@", reason]};
    }
#endif
}

- (void)beginDensity:(NSInteger)density copies:(NSInteger)copies completion:(void (^)(BOOL))completion {
    NSAssert(NSThread.isMainThread, @"The label SDK owner must run on the main queue");
#if TARGET_OS_SIMULATOR
    completion(NO);
#else
    if (!self.connected || !self.errorListenerReady || density < 1 || density > 5 || copies != 1) { completion(NO); return; }
    [JCAPI setPrintWithCache:NO];
    [JCAPI setTotalQuantityOfPrints:copies];
    [JCAPI startJob:(int)density withPaperStyle:1 withCompletion:^(BOOL accepted) {
        dispatch_async(dispatch_get_main_queue(), ^{ completion(accepted); });
    }];
#endif
}

- (void)commitJSON:(NSString *)json copies:(NSInteger)copies completion:(void (^)(BOOL))completion {
    NSAssert(NSThread.isMainThread, @"The label SDK owner must run on the main queue");
#if TARGET_OS_SIMULATOR
    completion(NO);
#else
    if (!self.connected || !self.errorListenerReady || copies != 1 || json.length == 0) { completion(NO); return; }
    [JCAPI commit:json withOnePageNumbers:(int)copies withComplete:^(BOOL accepted) {
        dispatch_async(dispatch_get_main_queue(), ^{ completion(accepted); });
    }];
#endif
}

- (void)printBitmapBase64:(NSString *)base64 widthMm:(double)widthMm heightMm:(double)heightMm density:(NSInteger)density
    completion:(void (^)(BOOL))completion {
    NSAssert(NSThread.isMainThread, @"The label SDK owner must run on the main queue");
#if TARGET_OS_SIMULATOR
    completion(NO);
#else
    if (!self.connected || !self.errorListenerReady || density < 1 || density > 5 || base64.length == 0) {
        completion(NO); return;
    }
    NSData *png = [[NSData alloc] initWithBase64EncodedString:base64 options:0];
    UIImage *image = png ? [UIImage imageWithData:png] : nil;
    if (!image.CGImage) { completion(NO); return; }
    size_t width = CGImageGetWidth(image.CGImage), height = CGImageGetHeight(image.CGImage);
    if (!width || !height) { completion(NO); return; }
    size_t expectedWidth = (size_t)ceil(widthMm * 8.0);
    size_t expectedHeight = (size_t)ceil(heightMm * 8.0);
    if (width != expectedWidth || height != expectedHeight) { completion(NO); return; }
    // JCAPI's direct bitmap channel expects composited ARGB pixels, not PNG
    // channel order. NIIMBOTBitmapBytes also removes transparency by filling
    // the page with white before drawing the label.
    NSData *argb = NIIMBOTBitmapBytes(image, YES);
    if (!argb) { completion(NO); return; }
    size_t rowBytes = width * 4;
    const unsigned char *src = argb.bytes;
    NSMutableData *binary = [NSMutableData dataWithLength:rowBytes * height];
    unsigned char *dst = binary.mutableBytes;
    for (size_t i = 0; i < width * height; i++) {
        const unsigned char *pixel = src + i * 4;
        // PremultipliedFirst is ARGB: alpha, red, green, blue.
        unsigned char luma = (unsigned char)((pixel[1] * 30 + pixel[2] * 59 + pixel[3] * 11 + 50) / 100);
        unsigned char value = luma < 128 ? 0 : 255;
        dst[i * 4] = pixel[0];
        dst[i * 4 + 1] = dst[i * 4 + 2] = dst[i * 4 + 3] = value;
    }
    [JCAPI setPrintWithCache:NO];
    [JCAPI setTotalQuantityOfPrints:1];
    NSUInteger generation = ++self.bitmapGeneration;
    self.pendingBitmapCompletion = completion;
    [JCAPI startJob:(int)density withPaperStyle:1 withCompletion:^(BOOL started) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.bitmapGeneration != generation) return;
            if (!started) {
                [self failPendingBitmapForGeneration:generation];
                return;
            }
            [JCAPI print:binary dataWidth:(unsigned int)width dataHeight:(unsigned int)height withCount:1
                withEpc:nil withDashLine:NO withComplete:^(BOOL printed) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (self.bitmapGeneration != generation) return;
                    if (!printed) {
                        [self failPendingBitmapForGeneration:generation];
                        return;
                    }
                    [self finishPendingBitmapForGeneration:generation];
                });
            }];
        });
    }];
#endif
}

- (void)finishPendingBitmapForGeneration:(NSUInteger)generation {
    // Printing callbacks are the reliable submission signal on K3. finish the
    // SDK job immediately instead of waiting for a count that may never arrive.
    if (self.bitmapGeneration != generation || !self.pendingBitmapCompletion) return;
    void (^completion)(BOOL) = self.pendingBitmapCompletion;
    self.pendingBitmapCompletion = nil;
    __block BOOL finished = NO;
    void (^finish)(void) = ^{
        if (finished) return;
        finished = YES;
        dispatch_async(dispatch_get_main_queue(), ^{ completion(YES); });
    };
    [JCAPI endPrint:^(BOOL ended) {
        // The official demo completes on the endPrint callback regardless of
        // its BOOL. Treat this BOOL as failure can report an already-printed
        // label as rejected. Printer errors still arrive through the listener.
        finish();
    }];
    // Some K3 firmware accepts endPrint but never invokes its completion.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)), dispatch_get_main_queue(), finish);
}

- (void)failPendingBitmapForGeneration:(NSUInteger)generation {
    if (self.bitmapGeneration != generation || !self.pendingBitmapCompletion) return;
    void (^completion)(BOOL) = self.pendingBitmapCompletion;
    self.pendingBitmapCompletion = nil;
    ++self.bitmapGeneration;
    __block BOOL finished = NO;
    void (^finish)(void) = ^{
        if (finished) return;
        finished = YES;
        dispatch_async(dispatch_get_main_queue(), ^{ completion(NO); });
    };
    [JCAPI cancelJob:^(BOOL acknowledged) { finish(); }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)), dispatch_get_main_queue(), finish);
}

- (void)cancel:(void (^)(BOOL))completion {
    NSAssert(NSThread.isMainThread, @"The label SDK owner must run on the main queue");
#if TARGET_OS_SIMULATOR
    completion(NO);
#else
    [JCAPI cancelJob:^(BOOL acknowledged) {
        dispatch_async(dispatch_get_main_queue(), ^{ completion(acknowledged); });
    }];
#endif
}

// K3 physical output remains a separate acceptance gate. The app releases the
// task after submission instead of waiting forever for an optional device count.
@end
