#import "NIIMBOTSDKAdapter.h"
#import <TargetConditionals.h>
#if !TARGET_OS_SIMULATOR
#import "Vendor/NIIMBOT/JCAPI.h"
#endif

@interface NIIMBOTSDKAdapter ()
@property(nonatomic) NSUInteger connectionGeneration;
@property(nonatomic, readwrite) BOOL errorListenerReady;
@end

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
    // Diagnostic evidence only. K3 counting has not been accepted and never drives completion.
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
        // Official documentation permits no custom font directory. Never bundle the Demo fonts.
        [JCAPI initImageProcessing:@"" error:&error];
        if (error) return @{@"errorCode": @"FONT_INITIALIZATION_FAILED", @"message": @"官方绘图库字体初始化失败"};
        [JCAPI initDrawingBoard:(float)width withHeight:(float)height withHorizontalShift:0
             withVerticalShift:0 rotate:0 fontArray:@[]];
        for (NSDictionary *element in elements) {
            float x = [element[@"x"] floatValue], y = [element[@"y"] floatValue];
            float w = [element[@"w"] floatValue], h = [element[@"h"] floatValue];
            BOOL drawn = NO;
            NSString *type = element[@"type"];
            if ([type isEqualToString:@"image"]) {
                // CoreText already shaped and measured this opaque black-on-white PNG.
                drawn = [JCAPI DrawLableImage:x withY:y withWidth:w withHeight:h
                    withImageData:element[@"imageBase64"] withRotate:0
                    withImageProcessingType:1 withImageProcessingValue:127];
            } else if ([type isEqualToString:@"qr"]) {
                drawn = [JCAPI drawLableQrCode:x withY:y withWidth:w withHeight:h
                    withString:element[@"text"] withRotate:0 withCodeType:31];
            } else if ([type isEqualToString:@"line"]) {
                drawn = [JCAPI DrawLableLine:x withY:y withWidth:w withHeight:h
                    withRotate:0 withLineType:1 withDashWidth:@[@1, @1]];
            }
            if (!drawn) return @{@"errorCode": @"DRAWING_FAILED", @"message": @"官方 SDK 无法绘制标签字段；请检查字体与版面"};
        }
        NSString *json = [JCAPI GenerateLableJson];
        if (json.length == 0) return @{@"errorCode": @"DRAWING_FAILED", @"message": @"官方 SDK 未生成标签数据"};
        UIImage *preview = [JCAPI generateImagePreviewImage:3 error:&error];
        NSData *png = preview ? UIImagePNGRepresentation(preview) : nil;
        if (error || !png || png.length == 0) return @{@"errorCode": @"PREVIEW_FAILED", @"message": @"官方 SDK 未生成有效预览"};
        return @{@"sdkJson": json, @"imageBase64": [png base64EncodedStringWithOptions:0]};
    } @catch (NSException *exception) {
        return @{@"errorCode": @"SDK_RENDER_EXCEPTION", @"message": @"官方绘图库发生异常；不能提交打印"};
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

// No endPrint call until a source-controlled K3 acceptance record proves a reliable end signal.
@end
