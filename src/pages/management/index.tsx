import { useRouter } from '@tarojs/taro';
import Workbench from '@/components/Workspace/workbench';
import BusinessForm, { isBusinessForm } from '@/components/BusinessForms';
import { DemoPage } from '@/components/DemoUI';

export default function ManagementPage() {
  const { params } = useRouter();
  if (params.section && !isBusinessForm(params.section) && !['stock', 'finance', 'suppliers', 'customers', 'records', 'photos', 'inbound'].includes(params.section)) {
    return <DemoPage title='页面不存在'><div className='demo-empty'>请从总台选择业务入口。</div></DemoPage>;
  }
  return isBusinessForm(params.section)
    ? <BusinessForm section={params.section} />
    : <Workbench />;
}
