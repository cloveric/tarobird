import Foundation
import CoreGraphics

@main
enum KeyboardInsetsTests {
    static func main() {
        var checks = 0
        func equal(_ actual: CGFloat, _ expected: CGFloat, _ label: String) {
            precondition(abs(actual - expected) < 0.01, "\(label): \(actual) != \(expected)")
            checks += 1
        }
        let phone = CGRect(x: 0, y: 0, width: 390, height: 844)
        for (width, height) in [(320.0, 568.0), (390, 844), (440, 956), (466, 678)] {
            for bounds in [CGRect(x: 0, y: 0, width: width, height: height), CGRect(x: 0, y: 0, width: height, height: width)] {
                precondition(!KeyboardInsetGeometry.tracksExpandedPhone(isPhone: true, bounds: bounds))
                checks += 1
            }
        }
        for bounds in [CGRect(x: 0, y: 0, width: 880, height: 605), CGRect(x: 0, y: 0, width: 687, height: 1000)] {
            precondition(KeyboardInsetGeometry.tracksExpandedPhone(isPhone: true, bounds: bounds))
            precondition(!KeyboardInsetGeometry.tracksExpandedPhone(isPhone: false, bounds: bounds))
            checks += 2
        }
        equal(KeyboardInsetGeometry.overlap(bounds: phone, guide: CGRect(x: 0, y: 810, width: 390, height: 34), restingBottom: 810), 0, "home indicator is not a keyboard")
        equal(KeyboardInsetGeometry.overlap(bounds: phone, guide: CGRect(x: 0, y: 544, width: 390, height: 300), restingBottom: 810), 300, "docked keyboard includes home indicator")
        equal(KeyboardInsetGeometry.overlap(bounds: phone, guide: CGRect(x: 0, y: 0, width: 0, height: 0), restingBottom: 810), 0, "initial empty guide")
        equal(KeyboardInsetGeometry.overlap(bounds: phone, guide: CGRect(x: 0, y: 844, width: 390, height: 0), restingBottom: 844), 0, "no bottom safe area")
        equal(KeyboardInsetGeometry.overlap(bounds: phone, guide: CGRect(x: 50, y: 350, width: 280, height: 260), restingBottom: 810), 0, "floating keyboard does not remove a bottom band")
        equal(KeyboardInsetGeometry.overlap(bounds: phone, guide: CGRect(x: 0, y: 544, width: 280, height: 300), restingBottom: 810), 0, "partial-width occlusion does not remove entire window")
        equal(KeyboardInsetGeometry.overlap(bounds: phone, guide: CGRect(x: 400, y: 544, width: 390, height: 300), restingBottom: 810), 0, "keyboard in another split window")
        let split = CGRect(x: 0, y: 0, width: 320, height: 500)
        equal(KeyboardInsetGeometry.overlap(bounds: split, guide: CGRect(x: 0, y: 400, width: 320, height: 300), restingBottom: 480), 100, "reserve only actual window intersection")
        equal(KeyboardInsetGeometry.overlap(bounds: split, guide: CGRect(x: 0, y: 510, width: 320, height: 300), restingBottom: 480), 0, "keyboard completely below this window")
        equal(KeyboardInsetGeometry.overlap(bounds: split, guide: CGRect(x: -40, y: -50, width: 500, height: 550), restingBottom: 480), 500, "occlusion clamped to current bounds")
        equal(KeyboardInsetGeometry.overlap(bounds: CGRect(x: 20, y: 30, width: 320, height: 500), guide: CGRect(x: 20, y: 430, width: 320, height: 100), restingBottom: 510), 100, "nonzero WebView coordinate origin")
        equal(KeyboardInsetGeometry.overlap(bounds: phone, guide: .null, restingBottom: 810), 0, "invalid geometry")
        let unfolded = CGRect(x: 0, y: 0, width: 910, height: 640)
        equal(KeyboardInsetGeometry.overlap(bounds: unfolded, guide: CGRect(x: 0, y: 340, width: 910, height: 300), restingBottom: 606), 300, "unfolded full-width keyboard reserves its bottom overlap")
        equal(KeyboardInsetGeometry.overlap(bounds: unfolded, guide: CGRect(x: 200, y: 340, width: 320, height: 300), restingBottom: 606), 0, "bottom-aligned floating keyboard does not shrink the whole window")
        precondition(KeyboardInsetGeometry.isBackEdge(20, safeLeft: 0))
        precondition(!KeyboardInsetGeometry.isBackEdge(25, safeLeft: 0))
        precondition(KeyboardInsetGeometry.isBackEdge(60, safeLeft: 48))
        precondition(!KeyboardInsetGeometry.isBackEdge(20, safeLeft: 48))
        precondition(!KeyboardInsetGeometry.isBackEdge(80, safeLeft: 48))
        checks += 5

        var motion = KeyboardInsetMotion()
        motion.begin(at: 10_000, duration: 250)
        var report = motion.consume(at: 10_050, animate: true)
        equal(report.at, 10_000, "motion retains OS start")
        equal(report.duration, 250, "motion retains OS duration")
        report = motion.consume(at: 10_060, animate: true)
        equal(report.duration, 0, "later guide corrections do not restart motion")
        motion.begin(at: 10_000, duration: 250)
        equal(motion.consume(at: 10_500, animate: true).duration, 0, "late delivery is immediate")
        motion.begin(at: 10_000, duration: 250)
        equal(motion.consume(at: 10_020, animate: false).duration, 0, "reload and resize snapshots are immediate")
        motion.begin(at: 10_000, duration: 250)
        equal(motion.consume(at: 9_000, animate: true).duration, 0, "clock change is immediate")
        motion.begin(at: 10_000, duration: .nan)
        equal(motion.consume(at: 10_000, animate: true).duration, 0, "invalid timing is immediate")
        print("KeyboardInsets: \(checks) checks passed")
    }
}
