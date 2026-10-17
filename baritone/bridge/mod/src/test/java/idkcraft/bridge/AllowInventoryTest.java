package idkcraft.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Build/Mine interleaves on the shared allowInventory holder (idkcraft-605b). */
public class AllowInventoryTest {

    private final AtomicBoolean v = new AtomicBoolean(false);

    @BeforeEach
    public void clear() {
        AllowInventory.reset();
        v.set(false);
    }

    private void acquire() {
        AllowInventory.acquire(v::get, v::set);
    }

    private void release() {
        AllowInventory.release(v::set);
    }

    @Test
    public void mineThenBuildOverlapKeepsOnUntilBothEnd() {
        acquire(); // mine
        acquire(); // build starts mid-mine
        release(); // mine ends mid-build
        assertTrue(v.get(), "build must keep allowInventory on");
        release(); // build ends
        assertFalse(v.get(), "no leak after both end");
    }

    @Test
    public void buildThenMineOverlapRestoresOriginal() {
        acquire(); // build
        acquire(); // mine
        release(); // build ends
        assertTrue(v.get());
        release(); // mine ends
        assertFalse(v.get());
    }

    @Test
    public void originalTrueStaysTrueAndExtraReleaseIsNoop() {
        v.set(true);
        acquire();
        release();
        release();
        assertTrue(v.get());
    }
}
