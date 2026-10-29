import { useRouter } from '@tarojs/taro';
import Workbench from '@/components/Workspace/workbench';
import BusinessForm, { isBusinessForm } from '@/components/BusinessForms';

export default function ManagementPage() {
  const { params } = useRouter();
  return isBusinessForm(params.section)
    ? <BusinessForm section={params.section} />
    : <Workbench />;
}
