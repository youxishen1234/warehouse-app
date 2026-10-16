//version 4.0.3 20251226

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

/**
 建议在iOS9以上系统使用
 */

/**
 条码模式枚举。

 该枚举定义了不同的条码格式，可用于标识和选择特定的条码格式。

 - JCBarcodeFormatCodebar: CODEBAR 1D 格式。
 - JCBarcodeFormatCode39: Code 39 1D 格式。
 - JCBarcodeFormatCode93: Code 93 1D 格式。
 - JCBarcodeFormatCode128: Code 128 1D 格式。
 - JCBarcodeFormatEan8: EAN-8 1D 格式。
 - JCBarcodeFormatEan13: EAN-13 1D 格式。
 - JCBarcodeFormatITF: ITF (Interleaved Two of Five) 1D 格式。
 - JCBarcodeFormatUPCA: UPC-A 1D 格式。
 - JCBarcodeFormatUPCE: UPC-E 1D 格式。

 */
typedef NS_ENUM(NSUInteger, JCBarcodeMode){
    //CODEBAR 1D format.
    JCBarcodeFormatCodebar      ,
    
    //Code 39 1D format.
    JCBarcodeFormatCode39       ,
    
    //Code 93 1D format.
    JCBarcodeFormatCode93       ,
    
    //Code 128 1D format.
    JCBarcodeFormatCode128      ,
    
    //EAN-8 1D format.
    JCBarcodeFormatEan8         ,
    
    //EAN-13 1D format.
    JCBarcodeFormatEan13        ,
    
    //ITF (Interleaved Two of Five) 1D format.
    JCBarcodeFormatITF          ,
    
    //UPC-A 1D format.
    JCBarcodeFormatUPCA         ,
    
    //UPC-E 1D format.
    JCBarcodeFormatUPCE
};

typedef NS_ENUM(NSUInteger,JCSDKCacheStatus){
    JCSDKCacheWillPrinting,
    JCSDKCachePrinting,
    JCSDKCacheWillPause,
    JCSDKCachePaused,
    JCSDKCacheWillCancel,
    JCSDKCacheCanceled,
    JCSDKCacheWillDone,
    JCSDKCacheDone,
    JCSDKCacheWillResume,
    JCSDKCacheResumed,
} ;

typedef NS_ENUM(NSUInteger,JCSDKCammodFontType) {
    JCSDKCammodFontTypeStandard = 0,
    JCSDKCammodFontTypeFreestyleScript,
    JCSDKCammodFontTypeOCRA,
    JCSDKCammodFontTypeHelveticaNeueLTPro,
    JCSDKCammodFontTypeTimesNewRoman,
    JCSDKCammodFontTypeMICR,
    JCSDKCammodFontTypeTerU24b,
    JCSDKCammodFontTypeSimpleChinese16Point = 55,
    JCSDKCammodFontTypeSimpleChinese24Point
};

typedef NS_ENUM(NSUInteger,JCSDKCammodRotation) {
    JCSDKCammodRotationDefault = 0,
    JCSDKCammodRotation90 = 90,
    JCSDKCammodRotation180 = 180,
    JCSDKCammodRotation270 = 270
};

typedef NS_ENUM(NSUInteger,JCSDKCammodGraphicsType) {
    JCSDKCammodGraphicsTypeHorizontalExt ,
    JCSDKCammodGraphicsTypeVerticalExt,
    JCSDKCammodGraphicsTypeHorizontalZip,
    JCSDKCammodGraphicsTypeVerticalZip
};





typedef void (^DidOpened_Printer_Block) (BOOL isSuccess)                ;
typedef void (^DidPrinted_Block)        (BOOL isSuccess)                ;
typedef void (^PRINT_INFO)              (NSString * printInfo)          ;
typedef void (^PRINT_STATE)             (BOOL isSuccess)                ;
typedef void (^PRINT_DIC_INFO)          (NSDictionary * printDicInfo)   ;
typedef void (^JCSDKCACHE_STATE)        (JCSDKCacheStatus status)       ;


typedef NS_ENUM(NSUInteger,JCSDKPrinterStatus){
    JCSDKPrinterStatusWillPause,
    JCSDKPrinterStatusPaused,
    JCSDKPrinterStatusWillResume,
    JCSDKPrinterStatusResumed,
};

typedef void (^onPrinterStatusChangedBlock) (JCSDKPrinterStatus status);

@interface JCAPI : NSObject
/**
 扫描附近的蓝牙打印机。
 
 该方法用于扫描附近的蓝牙打印机，并通过回调返回扫描到的打印机名称列表。
 
 @param completion 扫描完成回调块。扫描完成后，将调用此回调并传递扫描到的蓝牙打印机名称数组。
        数组 `scanedPrinterNames` 包含了扫描到的蓝牙打印机名称。如果未扫描到任何打印机，数组为空。
 */
+ (void)scanBluetoothPrinter:(void(^)(NSArray *scanedPrinterNames))completion;

/**
 蓝牙连接指定名称的打印机。
 
 该方法用于与指定名称的蓝牙打印机进行连接。连接状态的变化会通过传递的回调进行通知。
 
 @param printerName 要连接的蓝牙打印机的名称。
 @param completion 连接状态回调块。当连接状态发生变化时，将调用此回调并传递连接状态的结果。
        参数 `isSuccess` 代表是否成功连接打印机，YES 表示连接成功，NO 表示连接失败。
 */
+ (void)openPrinter:(NSString *)printerName
         completion:(DidOpened_Printer_Block)completion;


/**
 扫描附近的 Wi-Fi 打印机。
 
 该方法用于扫描附近的 Wi-Fi 打印机，并通过回调返回扫描到的打印机信息列表。
 
 @param completion 扫描完成回调块。扫描完成后，将调用此回调并传递扫描到的 Wi-Fi 打印机信息数组。
        数组 `scanedPrinterNames` 包含了扫描到的 Wi-Fi 打印机信息。每个元素是一个字典，包含以下字段：
        - `ipAdd`：打印机的 IP 地址。
        - `bleName`：蓝牙名字。
        - `port`：连接端口。
        - `availableClient`：可用客户端连接数。
 */
+ (void)scanWifiPrinter:(void(^)(NSArray *scanedPrinterNames))completion;

/**
 扫描附近的 Wi-Fi 打印机。
 
 该方法用于在指定的超时时间内扫描附近的 Wi-Fi 打印机，并通过回调返回扫描到的打印机名称列表。
 
 @param timeout 扫描超时时间，单位为秒。在这段时间内进行扫描操作。
 @param completion 扫描完成回调块。扫描完成后，将调用此回调并传递扫描到的 Wi-Fi 打印机名称数组。
        数组 `scanedPrinterNames` 包含了扫描到的 Wi-Fi 打印机名称。如果未扫描到任何打印机，数组为空。
 */
+ (void)scanWifiPrinter:(float)timeout withCompletion:(void(^)(NSArray *scanedPrinterNames))completion;

/**
配置打印机连接手机当前连接wifi。
 
 @param   wifiName        wifi账号（非必须）
 @param   password        wifi密码。
 @param   completion      配置打印机连接Wi-Fi是否成功。
 */
+ (void)configurationWifi:(NSString *)wifiName
                 password:(NSString *)password
               completion:(PRINT_DIC_INFO)completion;

/**
 获取Wi-Fi配网信息。

 该方法用于获取Wi-Fi配网信息，通常返回Wi-Fi名称。

 @param completion Wi-Fi名称的回调。
 */
+ (void)getWifiConfiguration:(PRINT_DIC_INFO)completion;




/**
 获取手机当前连接的Wi-Fi名称。

 该方法用于获取手机当前连接的Wi-Fi的名称。

 @return 返回手机当前连接的Wi-Fi名称。
 */
+ (NSString *)connectingWifiName;

/**
 Wi-Fi连接指定名称的打印机。
 
 @param   host             打印机的 IP 地址。
 @param   completion      连接打印机是否成功。（连接状态改变通过该回调返回）
 */
+(void)openPrinterHost:(NSString *)host
            completion:(DidOpened_Printer_Block)completion;

/**
连接指定IP的打印机并进行 Wi-Fi 连接。
该方法用于与指定 IP 地址的打印机建立 Wi-Fi 连接。连接状态的变化会通过传递的回调进行通知。

@param host 打印机的 IP 地址，用于指定要连接的打印机。
@param port 打印机的端口号，用于指定要连接的打印机。
@param completion 连接状态回调块。当连接状态发生变化时，将调用此回调并传递连接状态的结果。
       参数 `isSuccess` 代表是否成功连接打印机，YES 表示连接成功，NO 表示连接失败。
*/
+(void)openPrinterHost:(NSString *)host
                  port:(uint16_t)port
            completion:(DidOpened_Printer_Block)completion;


/**
 关闭当前打开的打印机连接。

 该方法用于关闭当前已经打开的打印机连接。在执行此操作后，将触发 `openPrinter:completion:` 方法的 `completion(NO)` 回调。

 注意：调用此方法会中断与打印机的连接。

 */
+ (void)closePrinter;


/**
 获取当前连接的打印机名称（蓝牙或 Wi-Fi）。
 
 该方法用于获取当前已连接的打印机的名称。对于 Wi-Fi 连接，返回的是打印机的 IP 地址。
 
 @return 当前连接的打印机名称。如果没有连接打印机，则返回 nil。
 */
+ (NSString *)connectingPrinterName;

/**
 获取当前的蓝牙/Wi-Fi连接状态。
 
 该方法用于获取当前设备的蓝牙和 Wi-Fi 连接状态。
 
 @return 返回值为整型，表示连接状态。0 表示无连接，1 表示连接蓝牙，2 表示连接 Wi-Fi。
 */
+ (int)isConnectingState;

/**
监听打印机状态变化
 
 @param   completion
 @{
    @"1": 盒盖状态-0打开/1关闭
    @"2": 电量等级变化-1/2/3/4
    @"3": 是否装有纸张-0没有/1有
    @"5": 碳带状态-0无碳带/1有碳带
    @"6": wifi信号强度
 }
 @return  是否支持监听打印机状态变化：YES:支持、NO:不支持
 */
+ (BOOL)getPrintStatusChange:(PRINT_DIC_INFO)completion;


/**
 获取打印机内安装的标签尺寸（目前仅支持M2机型，固件版本V1.24以上版本）
 注意事项:statusCode为0，paperType参数不为0时读取的参数有效
 @{@"statusCode":@"0",
    @"result":@{@"gapHeightPixel":arrs[0],//间隙高度(黑标高度)(单位像素)
            @"totalHeightPixel":arrs[1],//纸张高度(包含间隙)(单位像素)
            @"paperType":arrs[2],//纸张类型 ：1:间隙纸; 2:黑标纸; 3:连续纸; 4:定孔纸; 5:透明纸; 6:标牌;
            @"gapHeight":arrs[3],//间隙高度(黑标高度)(单位毫米)
            @"totalHeight":arrs[4],//纸张高度(包含间隙)(单位毫米)
            @"paperWidthPixel":arrs[5],//纸张宽度(包含间隙)(单位像素)
            @"paperWidth":arrs[6],//纸张宽度(包含间隙)(单位毫米)
            @"direction":arrs[7], //尾巴方向1上2下3左4右（暂不支持）
            @"tailLengthPixel":arrs[8],//尾巴长度(单位像素)
            @"tailLength":arrs[9]}} //尾巴长度(单位毫米)
 */
+ (void)getPaperInfo:(PRINT_DIC_INFO)completion;

/**
 影响缓存和暂停功能，缓存最多5个任务，用以提高打印的连续型，提高打印体验
  否启动SDK缓存：YES:启动、NO:不启动
 */
+ (void)setPrintWithCache:(BOOL)startCache;

/**
 打印机打印前传入总打印份数

 @param totalQuantityOfPrints 设置总打印份数，表示所有页面的打印份数之和。例如，如果你有3页需要打印，第一页打印3份，第二页打印2份，第三页打印5份，那么count的值应为10（3+2+5）。
 */
+ (void)setTotalQuantityOfPrints:(NSInteger)totalQuantityOfPrints;

/**
 蓝牙/Wi-Fi取消打印(打印未完成调用)。
 
 @param   completion      打印结束回调（在发生异常后不会返回）
 */
+ (void)cancelJob:(DidPrinted_Block)completion;

/**
 蓝牙/Wi-Fi打印完成(打印完成后调用)。
 
 @param   completion      打印结束回调（在发生异常后不会返回）
 */
+ (void)endPrint:(DidPrinted_Block)completion;

/**
 监听打印机暂停/恢复状态。
 
 @param   completion      回调打印机的暂停/恢复状态
 */
+(void)didReadPrinterStatus:(onPrinterStatusChangedBlock)completion;

/**
 暂停打印（回调在注册 didReadPrinterStatus 中返回）。
 */
+ (void)pause;

/**
 暂停后-恢复打印（回调在注册 didReadPrinterStatus 中返回）。
 */
+ (void)resume;

/**
 蓝牙/Wi-Fi打价器打印完成的份数(只对打价器有效，可能部分丢失，app做超时重置状态)。
 
 @param   count           打印完成的份数（在发生异常后不会返回）
 @{
    @"totalCount":@"总打印的张数计数" //返回必带的key
    @"pageCount":@"当前打印第PageNo页的第几份" //非必带
    @"pageNO":@"当前打印第几页"。 //非必带
    @"tid":@"写入rfid返回的tid码"  //非必带
    @"carbonUsed":@"碳带使用量，单位毫米"  //非必带
 }
 */
+ (void)getPrintingCountInfo:(PRINT_DIC_INFO)count;

/**
 * 蓝牙 / Wi-Fi 异常回调（连接成功后生效）
 *
 * @param error 异常编码，取值含义如下：
 *  1  盒盖打开
 *  2  缺纸
 *  3  电量不足
 *  4  电池异常
 *  5  手动停止
 *  6  数据错误（提交打印数据失败 / 图像生成失败 / 发送数据错误 / 打印机校验不通过）
 *  7  温度过高
 *  8  出纸异常
 *  9  打印忙碌（马达转动中或固件升级中）
 * 10  未检测到打印头
 * 11  环境温度过低
 * 12  打印头未锁紧
 * 13  未检测到碳带
 * 14  碳带不匹配
 * 15  碳带已用完
 * 16  不支持的纸张类型
 * 17  设置纸张失败
 * 18  设置打印模式失败
 * 19  设置打印浓度失败（仅上报，不阻断打印）
 * 20  写入 RFID 失败
 * 21  边距设置错误（边距必须大于 0，且上下边距之和小于画板高度，左右边距之和小于画板宽度）
 * 22  通讯异常（超时或指令持续被拒绝）
 * 23  打印机断开
 * 24  画板参数设置错误
 * 25  旋转角度参数错误
 * 26  JSON 参数错误（PC 端）
 * 27  出纸异常（上盖检测已关闭）
 * 28  检查纸张类型
 * 29  RFID 标签在非 RFID 模式下打印
 * 30  浓度设置不支持
 * 31  不支持的打印模式
 * 32  标签材质设置失败（超时或失败，不阻断打印）
 * 33  不支持的标签材质设置（阻断打印）
 * 50  非法标签
 * 51  非法碳带与标签
 * 52  固件接收数据超时
 * 53  非专用色带（色带型号不匹配）
 * 58  非正品耗材（标签与色带均未识别，适用于部分新机型）
 * 59  非正品色带（色带未识别，适用于部分新机型）
 * 60  耗材超限（标签与色带均超过使用限制，适用于部分新机型）
 * 61  色带超限（色带超过使用限制，适用于部分新机型）
 * 62  非正品标签（标签未识别，适用于部分新机型）
 * 63  标签超限（标签超过使用限制，适用于部分新机型）
 */
+ (void)getPrintingErrorInfo:(PRINT_INFO)error;

/**
像素转毫米(会对像素进行处理)。
 
 @param   pixel           像素
 @return  绘制参数
 */
+ (CGFloat)pixelToMm:(CGFloat)pixel;

/**
毫米转像素(会对毫米进行处理)。

 @param  mm       毫米
 @return  绘制参数
 */
+ (CGFloat)mmToPixel:(CGFloat)mm;


/**
 生成打印预览图像。
 
 该方法用于生成打印预览图像，根据提供的 JSON 数据以及分辨率和打印倍率参数进行生成。

 @param generatePrintPreviewImageJson 包含打印信息的 JSON 数据。
 @param displayMultiple 显示倍率，用于指定生成的图像的分辨率。
 @param printMultiple 打印机倍率，用于指定生成的图像的打印倍率。
 @param printPreviewImageType 预览图像类型，通常为固定值 1。
 @param error 用于接收错误信息的 NSError 对象的指针。如果生成预览图像时发生错误，将返回相应的错误信息。

 @return 返回生成的预览图像，如果生成失败则返回 nil。
 */
+ (UIImage *)generatePrintPreviewImage:(NSString*)generatePrintPreviewImageJson displayMultiple:(float)displayMultiple printMultiple:(float)printMultiple printPreviewImageType:(int)printPreviewImageType error:(NSError **)error;


/**
 初始化图像库。
 
 该方法用于设置字体文件夹的路径，以供后续的图像处理操作。在进行文本绘制和一维码文字绘制之前，必须先初始化图像库。
 
 @param fontFamilyPath 字体文件夹的完整路径。
 @param error 用于接收错误信息的 NSError 对象的指针。如果设置字体路径时发生错误，将返回相应的错误信息。
 
 @note
 在进行文本绘制和一维码文字绘制之前，请确保先调用此方法以初始化图像库。初始化失败时，将通过 `error` 参数返回错误信息。
 */
+(void) initImageProcessing:(NSString *) fontFamilyPath error:(NSError **)error;

/**
 准备打印任务。
 
 该方法用于准备打印任务，设置打印浓度和纸张类型，并在打印完成后通过回调通知结果。
 
 @param blackRules 打印浓度设置。具体值取决于打印机型号，可参考以下规则：
   - H1/H1S/D11/D110/D101/B16/D110_M/D11_H/N1(B18): 支持范围 1~3，默认值 2。
   - B21/B21S/B21_Pro/B11/B1/B203/B3S/B3S_P/B31/B4/M2_H/M3/K2/K3/K3_W: 支持范围 1~5，默认值 3。
   - B50&B50W/B32&B32R&Z401: 支持范围 1~15，默认值 8。
   - B11/B50/T7/T8系列: 0（随打印机设置）、1（最淡）、6（正常）、15（最浓）
 
 @param paperStyle 纸张类型设置。具体值取决于打印机型号，可参考以下规则：
   - H1/H1S/D11/D110/D101/B16/D110_M/D11_H/B21/B21S/B21_Pro/B1/B203/B3S/B3S_P/B31/B4/N1(B18)/B32&B32R&Z401/M2_H/M3/K2/K3/K3_W:
     1—间隙纸
     2—黑标纸
     3—连续纸
     4—定孔纸
     5—透明纸
     6—标牌
     10—黑标间隙纸
 
   - B11/B50/T7/T8系列:
     0：连续纸
     1：定位孔 (如果不支持定位孔，则自动切换至间隙纸)
     2：间隙纸
     3：黑标纸
 
 @param completion 打印完成回调块。当打印任务完成时，将调用此回调并传递打印结果。
 */
+ (void)startJob:(int)blackRules
  withPaperStyle:(int)paperStyle
  withCompletion:(DidPrinted_Block)completion;

/**
 打印二值化后的图片 bitmap 数据。

 该方法用于将二值化的图像数据提交到打印机上，可设置打印份数、EPC 码以及打印完成后的回调。

 @param data 包含二值化图像数据的 NSData 对象。
 @param width 图像宽度。
 @param height 图像高度。
 @param count 打印份数。
 @param epcCode EPC 码（可选）。
 @param completion 打印完成回调块。当打印任务完成时，将调用此回调并传递打印结果。
 */
+ (void)print:(nonnull NSData *)data
    dataWidth:(unsigned int)width
   dataHeight:(unsigned int)height
    withCount:(unsigned int)count
      withEpc:(nullable NSString *)epcCode
 withComplete:(DidPrinted_Block)completion;

/**
 打印二值化后的图片 bitmap 数据。
 
 该方法用于将二值化的图像数据提交到打印机上，可设置打印份数、EPC 码、是否有虚线以及打印完成后的回调。

 @param data 包含二值化图像数据的 NSData 对象。
 @param width 图像宽度。
 @param height 图像高度。
 @param count 打印份数。
 @param epcCode EPC 码（可选）。
 @param hasDashLine 是否包含虚线。
 @param completion 打印完成回调块。当打印任务完成时，将调用此回调并传递打印结果。
 */
+ (void)print:(nonnull NSData *)data
    dataWidth:(unsigned int)width
   dataHeight:(unsigned int)height
    withCount:(unsigned int)count
      withEpc:(nullable NSString *)epcCode
 withDashLine:(BOOL)hasDashLine
 withComplete:(DidPrinted_Block)completion;

/**
 毫米转像素。
 
 该方法用于将毫米单位的长度转换为像素单位，考虑到倍率因子。

 @param mm 毫米值。
 @param scaler 倍率因子。
 @return 返回整数，表示转换后的像素值。
 */
+ (int) mmToPixel:(float)mm scaler:(float)scaler;

/**
 像素转毫米。
 
 该方法用于将像素单位的长度转换为毫米单位，考虑到倍率因子。

 @param pixel 像素值。
 @param scaler 倍率因子。
 @return 返回浮点数，表示转换后的毫米值。
 */
+ (float) pixelToMm:(int)pixel scaler:(float)scaler;

/**
 获取倍率。
 
 该方法用于计算倍率，将屏幕物理尺寸与屏幕分辨率结合起来。

 @param templatePhysical 屏幕物理尺寸（毫米）。
 @param screenDisplaySize 屏幕分辨率宽度（像素）。
 @return 返回浮点数，表示计算得到的倍率。
 */
+ (float)getDisplayMultiple:(float)templatePhysical templateDisplayWidth:(int)screenDisplaySize;


/**
 毫米转英寸。
 
 该方法用于将毫米单位的长度转换为英寸单位。

 @param mm 毫米值。
 @return 返回浮点数，表示转换后的英寸值。
 */
+(float) mmToInch:(float) mm;

/**
 英寸转毫米。
 
 该方法用于将英寸单位的长度转换为毫米单位。

 @param inch 英寸值。
 @return 返回浮点数，表示转换后的毫米值。
 */
+(float) inchToMm:(float) inch;


/// 是否支持RFID写入功能
+(BOOL)isSupportWriteRFID;


/**
 初始化绘制画板。
 
 该方法用于初始化一个绘制画板，指定宽度、高度、水平偏移、竖直偏移、旋转角度以及可选的字体路径。

 @param width 画板的宽度（毫米）。
 @param height 画板的高度（毫米）。
 @param horizontalShift 画板的水平偏移（毫米）（暂不生效）。
 @param verticalShift 画板的竖直偏移（毫米）（暂不生效）。
 @param rotate 画板的旋转角度，通常为 0。
 @param font 字体名称（暂不生效）
 */
+(void)initDrawingBoard:(float)width
             withHeight:(float)height
    withHorizontalShift:(float)horizontalShift
      withVerticalShift:(float)verticalShift
                 rotate:(int) rotate
                   font:(NSString*)font;


/**
 初始化绘制画板。
 
 该方法用于初始化一个绘制画板，指定宽度、高度、水平偏移、竖直偏移、旋转角度以及可选的字体路径。

 @param width 画板的宽度（毫米）。
 @param height 画板的高度（毫米）。
 @param horizontalShift 画板的水平偏移（毫米）（暂不生效）。
 @param verticalShift 画板的竖直偏移（毫米）（暂不生效）。
 @param rotate 画板的旋转角度，通常为 0。
 @param fonts 字体数组
 */
+(void)initDrawingBoard:(float)width
             withHeight:(float)height
    withHorizontalShift:(float)horizontalShift
      withVerticalShift:(float)verticalShift
                 rotate:(int) rotate
              fontArray:(NSArray<NSString*> *)fonts;

/**
 绘制文本。
 
 该方法用于在绘制画板上绘制文本，可以指定文本的位置、尺寸、内容、字体、字体大小、旋转角度、对齐方式、换行方式以及字体样式。

 @param x 水平起点（毫米）。
 @param y 竖直起点（毫米）。
 @param w 宽度（毫米）。
 @param h 高度（毫米）。
 @param text 文本内容。
 @param fontFamily 字体名称。
 @param fontSize 字体大小。
 @param rotate 旋转角度。
 @param textAlignHorizonral 文本水平对齐方式：0（左对齐）、1（居中对齐）、2（右对齐）。
 @param textAlignVertical 文本竖直对齐方式：0（顶对齐）、1（垂直居中）、2（底对齐）。
 @param lineMode 换行方式。
 @param letterSpacing 字体间隔。
 @param lineSpacing 行间隔。
 @param fontStyles 字体样式，为包含布尔值的数组，通常包括斜体、加粗、下划线、删除下划线。

 @return 返回布尔值，表示文本是否成功绘制。
 
 @note
 文本绘制之前，请确保先调用此方法以初始化图像库。
 */
+(BOOL)drawLableText:(float)x
               withY:(float)y
           withWidth:(float)w
          withHeight:(float)h
          withString:(NSString *)text
      withFontFamily:(NSString *)fontFamily
        withFontSize:(float)fontSize
          withRotate:(int)rotate
withTextAlignHorizonral:(int)textAlignHorizonral
withTextAlignVertical:(int)textAlignVertical
        withLineMode:(int)lineMode
   withLetterSpacing:(float)letterSpacing
     withLineSpacing:(float)lineSpacing
       withFontStyle:(NSArray <NSNumber *>*)fontStyles;


/**
 绘制一维码。
 
 该方法用于在绘制画板上绘制一维码（条码），可以指定条码的位置、尺寸、内容、字号、旋转角度、类型以及相关文本信息。

 @param x 水平坐标（毫米）。
 @param y 垂直坐标（毫米）。
 @param w 条码宽度（毫米）。
 @param h 条码高度（毫米）（含文本高度）。
 @param text 条码内容。
 @param fontSize 文本字号。
 @param rotate 旋转角度，仅支持 0, 90, 180, 270。
 @param codeType 一维码类型：
   - 20: CODE128
   - 21: UPC-A
   - 22: UPC-E
   - 23: EAN8
   - 24: EAN13
   - 25: CODE93
   - 26: CODE39
   - 27: CODEBAR
   - 28: ITF25
 @param textHeight 文本高度（毫米）。
 @param textPosition 一维码文字识别码显示位置：
   - 0: 下方显示
   - 1: 上方显示
   - 2: 不显示

 @return 返回布尔值，表示条码是否成功绘制。
 
 @note
 一维码绘制之前，请确保先调用此方法以初始化图像库。
 */
+(BOOL)drawLableBarCode:(float)x
                  withY:(float)y
              withWidth:(float)w
             withHeight:(float)h
             withString:(NSString *)text
           withFontSize:(float)fontSize
             withRotate:(int)rotate
           withCodeType:(int)codeType
         withTextHeight:(float)textHeight
       withTextPosition:(int)textPosition;


/**
 绘制二维码。
 
 该方法用于在绘制画板上绘制二维码，可以指定二维码的位置、尺寸、内容、旋转角度、类型。

 @param x 水平坐标（毫米）。
 @param y 垂直坐标（毫米）。
 @param w 二维码宽度（毫米）。
 @param h 二维码高度（毫米）。
 @param text 二维码内容。
 @param rotate 旋转角度，仅支持 0, 90, 180, 270。
 @param codeType 二维码类型：
   - 31: QR_CODE
   - 32: PDF417
   - 33: DATA_MATRIX
   - 34: AZTEC

 @return 返回布尔值，表示二维码是否成功绘制。
 */
+(BOOL)drawLableQrCode:(float)x
                 withY:(float)y
             withWidth:(float)w
            withHeight:(float)h
            withString:(NSString *)text
            withRotate:(int)rotate
          withCodeType:(int)codeType;


/**
 绘制线条。
 
 该方法用于在绘制画板上绘制线条，可以指定线条的位置、尺寸、旋转角度、类型以及虚线的宽度和样式。

 @param x 水平坐标（毫米）。
 @param y 垂直坐标（毫米）。
 @param w 线条宽度（毫米）。
 @param h 线条高度（毫米）。
 @param rotate 旋转角度，仅支持 0, 90, 180, 270。
 @param lineType 线条类型：
   - 1: 实线
   - 2: 虚线类型，虚实比例 1:1。
 @param dashWidth 虚线的宽度，为包含两个数字的数组，表示实线段长度和空线段长度。

 @return 返回布尔值，表示线条是否成功绘制。
 */
+(BOOL)DrawLableLine:(float)x
               withY:(float)y
           withWidth:(float)w
          withHeight:(float)h
          withRotate:(int)rotate
        withLineType:(int)lineType
       withDashWidth:(NSArray <NSNumber *>*)dashWidth;


/**
 绘制形状。
 
 该方法用于在绘制画板上绘制形状，可以指定形状的位置、尺寸、线条宽度、圆角、旋转角度、类型以及线条的样式。

 @param x 水平坐标（毫米）。
 @param y 垂直坐标（毫米）。
 @param w 形状宽度（毫米）。
 @param h 形状高度（毫米）。
 @param lineWidth 线条宽度（毫米）。
 @param cornerRadius 图像圆角（毫米）。
 @param rotate 旋转角度，仅支持 0, 90, 180, 270。
 @param graphType 图形类型。
 @param lineType 线条类型：
   - 1: 实线
   - 2: 虚线类型，虚实比例 1:1。
 @param dashWidth 线条的宽度，为包含两个数字的数组，表示实线段长度和空线段长度。

 @return 返回布尔值，表示形状是否成功绘制。
 */
+(BOOL)DrawLableGraph:(float)x
                withY:(float)y
            withWidth:(float)w
           withHeight:(float)h
        withLineWidth:(float)lineWidth
     withCornerRadius:(float)cornerRadius
           withRotate:(int)rotate
        withGraphType:(int)graphType
         withLineType:(int)lineType
        withDashWidth:(NSArray <NSNumber *>*)dashWidth;


/**
 绘制图片。
 
 该方法用于在绘制画板上绘制图片，可以指定图片的位置、尺寸、图像数据、旋转角度、处理算法以及阈值。

 @param x 水平坐标（毫米）。
 @param y 垂直坐标（毫米）。
 @param w 图像宽度（毫米）。
 @param h 图像高度（毫米）。
 @param imageData 图像的 Base64 数据。
 @param rotate 旋转角度，仅支持 0, 90, 180, 270。
 @param imageProcessingType 图像处理算法（默认1）。
 @param imageProcessingValue 阈值（默认127）。

 @return 返回布尔值，表示图片是否成功绘制。
 */
+(BOOL)DrawLableImage:(float)x
                withY:(float)y
            withWidth:(float)w
           withHeight:(float)h
        withImageData:(NSString *)imageData
           withRotate:(int)rotate
withImageProcessingType:(int)imageProcessingType
withImageProcessingValue:(float)imageProcessingValue;

/**
 生成标签数据的 JSON 字符串。

 该方法用于生成标签数据的 JSON 字符串，以便提交给打印机进行打印。

 @return 返回生成的标签数据的 JSON 字符串。
 */
+(NSString *)GenerateLableJson;


/**
 获取标签预览图像。

 该方法用于生成标签的预览图像，可以指定显示倍率和错误码。

 @param displayScale 显示倍率。
 @param error 返回的错误码，如果成功，error 为 nil。

 @return 返回生成的标签预览图像。
 */
+(UIImage *)generateImagePreviewImage:(float)displayScale error:(NSError **)error;


/**
 开始打印标签任务。

 该方法用于提交打印数据，指定打印份数和回调处理。

 @param printData 打印数据，通常为标签的 JSON 字符串。
 @param onePageNumbers 用于指定当前页的打印份数。例如，如果你需要打印3页，第一页打印3份，第二页打印2份，第三页打印5份，那么在3次提交数据时，onePageNumbers值分别应为3，2，5。
 @param completion 打印完成回调，用于处理打印任务是否成功的结果。

 */
+ (void)commit:(NSString *)printData
withOnePageNumbers:(int)onePageNumbers
  withComplete:(DidPrinted_Block)completion;

/**
 开始打印标签任务。

 该方法用于提交打印数据，指定打印份数、写入RFID数据和回调处理。

 @param printData 打印数据，通常为标签的 JSON 字符串。
 @param onePageNumbers 用于指定当前页的打印份数。例如，如果你需要打印3页，第一页打印3份，第二页打印2份，第三页打印5份，那么在3次提交数据时，onePageNumbers值分别应为3，2，5。
 @param epcCode 要写入的RFID数据。可以为nil，表示不写入RFID数据。（仅支持B32R机型）
 @param completion 打印完成回调，用于处理打印任务是否成功的结果。
 */
+ (void)commit:(NSString *)printData
withOnePageNumbers:(int)onePageNumbers
       withEpc:(nullable NSString *)epcCode
  withComplete:(DidPrinted_Block)completion;

@end

