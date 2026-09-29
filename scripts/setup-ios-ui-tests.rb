#!/usr/bin/env ruby
# Run after pod install in a disposable CI checkout. Never changes the App
# target's sources or the production App scheme. Requires CocoaPods' xcodeproj.
require 'xcodeproj'

root = File.expand_path('..', __dir__)
project_path = File.join(root, 'ios/App/App.xcodeproj')
project = Xcodeproj::Project.open(project_path)
apps = project.targets.select { |target| target.product_type == 'com.apple.product-type.application' }
abort 'Expected the single existing App application target' unless apps.length == 1 && apps.first.name == 'App'
app = apps.first
test_name = 'NativeDockUITests'
test = project.targets.find { |target| target.name == test_name }
abort "Existing #{test_name} target is not a UI test bundle" if test && test.product_type != 'com.apple.product-type.bundle.ui-testing'
test ||= project.new_target(:ui_test_bundle, test_name, :ios, '26.0')
test.add_dependency(app) unless test.dependencies.any? { |dependency| dependency.target == app }

sources = Dir[File.join(root, 'ios/App/AppUITests/*.swift')].sort
abort 'No native UI test Swift sources were found' if sources.empty?
group = project.main_group.find_subpath('AppUITests', true)
group.set_source_tree('<group>')
group.set_path('AppUITests')
sources.each do |source|
  name = File.basename(source)
  reference = group.files.find { |file| file.path == name } || group.new_file(name)
  test.source_build_phase.add_file_reference(reference, true)
end
app_bundle_id = app.build_configurations.find { |config| config.name == 'Debug' }.build_settings.fetch('PRODUCT_BUNDLE_IDENTIFIER')
test.build_configurations.each do |config|
  config.build_settings.merge!(
    'PRODUCT_BUNDLE_IDENTIFIER' => "#{app_bundle_id}.nativeuitests",
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'TEST_TARGET_NAME' => app.name,
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'SWIFT_VERSION' => '5.0',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'IPHONEOS_DEPLOYMENT_TARGET' => '26.0',
    'CODE_SIGNING_ALLOWED' => 'NO',
    'CODE_SIGNING_REQUIRED' => 'NO',
    'SDKROOT' => 'iphoneos',
    'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks', '@loader_path/Frameworks']
  )
end
project.root_object.attributes['TargetAttributes'] ||= {}
project.root_object.attributes['TargetAttributes'][test.uuid] = { 'TestTargetID' => app.uuid }
project.save

scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.add_build_target(test, false)
scheme.set_launch_target(app)
scheme.add_test_target(test)
scheme.test_action.build_configuration = 'Debug'
scheme.launch_action.build_configuration = 'Debug'
scheme.save_as(project_path, test_name, true)
puts "Prepared shared #{test_name} scheme; UI target app: #{app.name} (#{app_bundle_id})"
