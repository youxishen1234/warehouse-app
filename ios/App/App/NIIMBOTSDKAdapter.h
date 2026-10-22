#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The only application-owned caller of JCAPI. All entry points run on the main queue.
@interface NIIMBOTSDKAdapter : NSObject
+ (instancetype)sharedAdapter NS_SWIFT_NAME(shared());
@property(nonatomic, readonly) BOOL supported;
@property(nonatomic, readonly) BOOL connected;
@property(nonatomic, readonly, nullable) NSString *connectedPrinterName;
@property(nonatomic, readonly) BOOL errorListenerReady;
@property(nonatomic, copy, nullable) void (^connectionChanged)(BOOL connected);
@property(nonatomic, copy, nullable) void (^printingError)(NSString *code);
@property(nonatomic, copy, nullable) void (^diagnosticCount)(NSDictionary *count);
- (void)scan:(void (^)(NSArray<NSString *> *names))completion;
- (void)connectPrinter:(NSString *)printerName completion:(void (^)(BOOL accepted))completion
    NS_SWIFT_NAME(connect(printerName:completion:));
- (void)disconnect;
/// Elements originate exclusively in LabelTemplateRenderer, never from a JS call.
/// Returns SDK-generated JSON and preview, or a stable error code/message.
- (NSDictionary *)renderWidth:(double)width height:(double)height elements:(NSArray<NSDictionary *> *)elements
    NS_SWIFT_NAME(render(width:height:elements:));
- (void)beginDensity:(NSInteger)density copies:(NSInteger)copies completion:(void (^)(BOOL accepted))completion
    NS_SWIFT_NAME(begin(density:copies:completion:));
- (void)commitJSON:(NSString *)json copies:(NSInteger)copies completion:(void (^)(BOOL accepted))completion
    NS_SWIFT_NAME(commit(json:copies:completion:));
/// Direct full-page bitmap channel (JCAPI print:dataWidth:dataHeight:), used
/// because the K3 rejects calibration content drawn through DrawLableImage.
- (void)printBitmapBase64:(NSString *)base64 widthMm:(double)widthMm heightMm:(double)heightMm density:(NSInteger)density
    completion:(void (^)(BOOL accepted))completion
    NS_SWIFT_NAME(printBitmap(base64:widthMm:heightMm:density:completion:));
- (void)cancel:(void (^)(BOOL acknowledged))completion;
@end

NS_ASSUME_NONNULL_END
