import UIKit

// Unstyled UIKit reference for comparing the custom bridge-compatible variant.
final class SystemReferenceController: UITabBarController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let titles = ["首页", "入库", "出库", "我的"]
        let symbols = ["house", "tray.and.arrow.down", "tray.and.arrow.up", "person.crop.circle"]
        viewControllers = titles.indices.map { index in
            let controller = ReferenceListController()
            controller.title = titles[index]
            controller.tabBarItem = UITabBarItem(title: titles[index], image: UIImage(systemName: symbols[index]), tag: index)
            return controller
        }
    }
}
private final class ReferenceListController: UITableViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
        tableView.rowHeight = 160
        tableView.separatorStyle = .none
    }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { 24 }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        let colors: [UIColor] = [.systemTeal, .systemOrange, .systemBlue]
        cell.contentView.backgroundColor = colors[indexPath.row % colors.count].withAlphaComponent(0.22)
        cell.textLabel?.text = "系统 Tab 参考 · " + String(indexPath.row + 1) + "   1,200 张"
        cell.textLabel?.font = .systemFont(ofSize: 22, weight: .semibold)
        return cell
    }
}
