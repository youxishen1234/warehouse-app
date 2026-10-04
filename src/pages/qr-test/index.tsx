import { useEffect, useMemo, useState } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import QRCode from 'qrcode';
import styles from './index.module.scss';
type QrData = { warehouse: string; code: string; name: string; specification: string; material: string; unit: string; quantity: string; price: string };
const initial: QrData = { warehouse: '曙光仓库', code: '0015246', name: '纸箱成品', specification: '40×40×30', material: '五层AB楞', unit: '个', quantity: '600', price: '3.80' };
const fields: Array<[keyof QrData, string]> = [['warehouse','仓库'],['code','编号'],['name','名称'],['specification','规格'],['material','材质'],['unit','单位'],['quantity','数量'],['price','单价']];
export default function QrTestPage() {
  const [data,setData] = useState(initial); const [qr,setQr] = useState('');
  const payload = useMemo(() => JSON.stringify({ type:'shuguang-warehouse-spec', version:1, ...data }), [data]);
  useEffect(() => { QRCode.toDataURL(payload,{width:720,margin:3,errorCorrectionLevel:'M',color:{dark:'#102c2b',light:'#ffffff'}}).then(setQr); }, [payload]);
  const patch = (key:keyof QrData,value:string) => setData(current => ({...current,[key]:value}));
  return <ScrollView scrollY className={styles.page}><View className={styles.hero}><Text className={styles.eyebrow}>SHUGUANG WAREHOUSE</Text><Text className={styles.title}>规格二维码测试</Text><Text className={styles.subTitle}>扫码即可看到这件货的规格资料</Text></View><View className={styles.card}><Text className={styles.cardTitle}>编辑测试内容</Text><View className={styles.fields}>{fields.map(([key,label]) => <View className={styles.field} key={key}><Text className={styles.label}>{label}</Text><Input className={styles.input} value={data[key]} onInput={event => patch(key,event.detail.value)} /></View>)}</View></View><View className={styles.printCard}><Text className={styles.paperTitle}>曙光仓库 · 规格标签</Text>{qr && <img className={styles.qr} src={qr} alt='曙光仓库规格二维码' />}<Text className={styles.scanHint}>扫一扫查看规格</Text><View className={styles.detailGrid}>{fields.map(([key,label]) => <View className={styles.detail} key={key}><Text>{label}</Text><strong>{data[key] || '—'}</strong></View>)}</View><Text className={styles.payload}>{payload}</Text></View><View className={styles.actions}><View className={styles.primary} onClick={() => typeof window !== 'undefined' && window.print()}>打印这张测试标签</View><Text className={styles.note}>建议使用 A4 纸打印，打印窗口可另存为 PDF。</Text></View></ScrollView>;
}
