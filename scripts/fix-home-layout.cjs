const fs = require('node:fs');
const file = 'src/pages/home/index.tsx';
let source = fs.readFileSync(file, 'utf8');
source = source.replace("import type { IconName } from '@/components/Icon';", '');
const start = source.indexOf('type QuickAction =');
const end = source.indexOf('const WEEK =', start);
if (start >= 0) source = source.slice(0, start) + source.slice(end);
const begin = source.indexOf('      <View className={styles.topbar}>');
const finish = source.indexOf('      <View className={styles.sectionHead}><Text className={styles.sectionTitle}>今日任务', begin);
if (begin < 0 || finish < 0) throw new Error('Home layout boundaries missing');
source = source.slice(0, begin) + `      <View className={styles.heroNote}>
        <Text className={styles.heroDate}>{dateText}</Text>
        <Text className={styles.linkButton} onClick={() => loadData(true)}>刷新</Text>
      </View>
      <View className={styles.businessCenter} role='button' aria-label='进入业务中心' onClick={() => goTo('/pages/business-center/index')}>
        <View className={styles.customerDeskIcon}><Icon name='clipboard' color='#fff' /></View>
        <View><Text className={styles.customerDeskTitle}>业务中心</Text><Text className={styles.businessSubtitle}>纸板库存 · 客户管理 · 订单出库</Text></View>
        <Text className={styles.customerDeskArrow}>›</Text>
      </View>
      <View className={styles.customerDesk} role='button' aria-label='进入客户尺寸本' onClick={() => goTo('/pages/customer-desk/index')}>
        <View className={styles.customerDeskIcon}><Icon name='mine' color='#fff' /></View>
        <View><Text className={styles.customerDeskTitle}>客户尺寸本</Text><Text className={styles.customerDeskSubtitle}>选公司 · 选规格 · 填数量 · 打印或发货</Text></View>
        <Text className={styles.customerDeskArrow}>›</Text>
      </View>

` + source.slice(finish);
fs.writeFileSync(file, source);
